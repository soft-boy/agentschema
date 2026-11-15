import { join } from "node:path";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { DeploymentCreateParams, DeploymentUpdateParams } from "@anthropic-ai/sdk/resources/beta/deployments";
import type { CredentialUpdateParams } from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import { CHANNELS_DIR, readChannels } from "../lib/channels.ts";
import { type CheckOptions, checkFiles } from "../lib/check.ts";
import type { FileMap } from "../lib/files.ts";
import {
  AGENT_FILE, ENVIRONMENT_KEY, type Instance, type Lock, type LockEntry, agentBody, envBody, environmentEntry, upgradeLock,
} from "../lib/instance.ts";
import type { Frontmatter } from "../lib/markdown.ts";
import { type TaskBody, taskBody, taskKey, taskSettings } from "../lib/scheduled.ts";
import { type Skill, type SkillRef, skillKey, skillRefs } from "../lib/skills.ts";
import { AGENTBOOK } from "../lib/tools.ts";
import {
  ENV_VAR, type Credential, type CredentialSettings, type Vault, type VaultBody,
  changedImmutableFields, credentialKey, credentialSettings, vaultBody, vaultKey,
} from "../lib/vaults.ts";
import { folderProblem, readFolder } from "./folder.ts";
import { LOCK_FILE, type SkillFingerprint, hashBody, readLock, skillFingerprint, writeLock } from "./lock.ts";

export class DeployError extends Error {}

export type ResourceKind = "skill" | "environment" | "agent" | "vault" | "credential" | "deployment";
export type DeployAction = "create" | "update" | "unchanged" | "missing" | "pause" | "unpause" | "archive";

// One resource in a deploy's plan: what was done to it, or in a dry run what would be. `id` and
// `version` are what the lock has for it afterwards (a dry run has none for what it would create).
export interface PlanEntry {
  file: string;
  kind: ResourceKind;
  action: DeployAction;
  id: string | undefined;
  version: string | undefined;
}

export type Log = (message: string) => void;
export type SaveLock = (lock: Lock) => void | Promise<void>;

// A lock after prepareLock: it always has `resources`, and `origin` says which API it was written for.
export interface PreparedLock extends Lock {
  version?: number;
  origin?: { base_url?: string };
  resources: Record<string, LockEntry>;
}

export interface DeployOptions {
  client: Anthropic;
  dryRun?: boolean;
  force?: boolean;
  log?: Log;
}

export interface DeployFilesOptions extends DeployOptions {
  files: FileMap;
  lock?: Lock | null;
  saveLock?: SaveLock;
  checkOptions?: CheckOptions;
  pathOf?: (file: string) => string;
  scheduled?: boolean;
}

export interface DeployResult {
  plan: PlanEntry[];
  lock: PreparedLock;
}

// What pauseScheduled and archiveScheduled take.
export interface ScheduledLockOptions {
  lock: Lock | null | undefined;
  client: Anthropic;
  saveLock?: SaveLock;
}

// The resource an API call is for, which errors name. retrieve() also says its lock key and entry.
export interface StepRef {
  file: string;
  kind: string;
  key?: string;
  entry?: LockEntry;
}

type PlannedAction = "create" | "update" | "unchanged";

// A resource being deployed: its request body, that body's hash, its lock entry from the last
// deploy, and what's to be done to it.
interface Step<K extends ResourceKind, B, A extends DeployAction = PlannedAction> {
  file: string;
  key: string;
  kind: K;
  body: B;
  hash: string;
  entry: LockEntry | undefined;
  action: A;
}

type SkillStep = Step<"skill", SkillFingerprint>;
type InstanceStep = Step<"environment" | "agent", Frontmatter>;
type VaultStep = Step<"vault", VaultBody>;

interface CredentialStep extends Step<"credential", CredentialSettings, PlannedAction | "missing"> {
  cred: Credential;
  vaultStep: VaultStep;
  remote?: Anthropic.Beta.Vaults.BetaManagedAgentsCredential;
}

// A scheduled task's deployment body. A dry run has "pending" stand-ins for IDs and versions that
// don't exist yet, but a dry run sends nothing.
interface DeploymentBody extends TaskBody {
  agent: { type: "agent"; id: string; version: number | "pending" };
  environment_id: string;
  vault_ids: string[];
}

interface TaskStep extends Step<"deployment", DeploymentBody, PlannedAction | "pause" | "unpause"> {
  isChanged?: boolean;
}

// The deployment of a task whose file is gone.
interface ArchiveStep {
  file: string;
  key: string;
  kind: "deployment";
  action: "archive";
  entry: LockEntry;
}

// What each kind of resource's deploy step is given.
interface StepOptions {
  client: Anthropic;
  lock: PreparedLock;
  dryRun: boolean;
  log: Log;
  saveLock: SaveLock;
}

// Deploys an agent folder, keeping the lock in its claude-lock.json. Returns the plan: one
// { file, kind, action, id, version } entry per resource.
export async function deploy(dir: string, { client, dryRun = false, force = false, log = () => {} }: DeployOptions): Promise<PlanEntry[]> {
  const problem = folderProblem(dir);
  if (problem) throw new DeployError(`check failed:\n  ${problem}`);
  const files = readFolder(dir);
  const { plan } = await deployFiles({
    files,
    lock: readLock(dir),
    client,
    dryRun,
    force,
    log,
    saveLock: (lock) => writeLock(dir, lock),
    pathOf: (file) => join(dir, file),
  });
  if (readChannels(files).channels.length > 0) log(`${CHANNELS_DIR}/ isn't connected by deploying from here; a channel needs a host that's always on, such as Agentbook`);
  return plan;
}

// Creates or updates the skills, environment, agent, vaults and scheduled tasks in a file map (see
// lib/files.js). Skills go first, because the agent refers to their IDs and versions, and scheduled
// tasks go last, because they refer to everything else. Credentials are only updated here: creating
// one needs its secrets, so that's `cred deploy`'s job.
//
//   lock          the IDs from the last deploy, or null for a first deploy
//   saveLock      called with the lock as soon as each resource exists, so a failure later
//                 doesn't orphan it; it may be async
//   checkOptions  what checkFiles takes: { customTools, toolsets }
//   pathOf        how to show a file's path to the user in messages
//   scheduled     false leaves scheduled tasks alone, for a copy of the agent that's only for trying
//                 it out
//
// Returns { plan, lock }. A dry run calls neither the API nor saveLock.
export async function deployFiles({
  files, lock: previous = null, client, dryRun = false, force = false, log = () => {},
  saveLock = () => {}, checkOptions = {}, pathOf = (file) => file, scheduled = true,
}: DeployFilesOptions): Promise<DeployResult> {
  const { errors, instance: checked } = checkFiles(files, checkOptions);
  if (errors.length > 0) throw new DeployError(`check failed:\n  ${errors.join("\n  ")}`);
  // checkFiles only leaves instance null when there are errors.
  const instance = checked!;
  const agentbook = instance.tools.find((t) => t.data.type === AGENTBOOK);
  if (agentbook && !checkOptions.toolsets) {
    throw new DeployError(`${agentbook.file}: this toolset runs on agentbook, so it can only be deployed from there`);
  }
  const lock = prepareLock(previous, client);

  const skillSteps = await deploySkills(instance.skills, { client, lock, dryRun, log, saveLock });
  // A dry run has no new IDs or versions yet, so a stand-in shows that the agent will change too.
  const pending = dryRun ? skillSteps.filter((s) => s.action !== "unchanged") : [];
  const refs = instance.skills.flatMap((skill): SkillRef[] => {
    const step = pending.find((s) => s.key === skillKey(skill));
    if (!step) return skillRefs([skill], lock);
    return [{ type: "custom", skill_id: step.entry?.id ?? `pending:${skill.name}`, version: `pending:${step.hash}` }];
  });

  // hash, entry and action are filled in just below.
  const steps = [
    { file: instance.env.file, key: ENVIRONMENT_KEY, kind: "environment", body: envBody(instance) },
    { file: AGENT_FILE, key: `./${AGENT_FILE}`, kind: "agent", body: agentBody(instance, refs, checkOptions) },
  ] as InstanceStep[];
  for (const step of steps) {
    step.hash = hashBody(step.body);
    step.entry = lock.resources[step.key];
    if (step.entry && step.entry.kind !== step.kind) {
      throw new DeployError(`${LOCK_FILE}: entry for ${step.key} is a ${step.entry.kind}, expected ${step.kind}`);
    }
    step.action = !step.entry ? "create" : step.entry.hash === step.hash ? "unchanged" : "update";
  }

  for (const step of steps) {
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? ""}`.trimEnd());
      continue;
    }
    const result: { id: string; version?: number } = step.kind === "environment"
      ? await deployEnvironment(client, step)
      : await deployAgent(client, step, force);

    lock.resources[step.key] = step.kind === "agent"
      ? { kind: "agent", id: result.id, version: String(result.version), hash: step.hash }
      : { kind: "environment", id: result.id, hash: step.hash };
    // Record each resource as soon as it exists, so a failure later doesn't orphan it.
    await saveLock(lock);

    const version = step.kind === "agent" ? ` (version ${result.version})` : "";
    log(`${(step.action === "create" ? "created" : "updated").padEnd(9)} ${step.kind} ${result.id}${version}`);
  }

  const vaultSteps = await deployVaults(instance.vaults, { client, lock, dryRun, log, saveLock, pathOf });

  // A dry run has no IDs for what it would create, or versions for what it would change.
  const pendingAgent = dryRun && steps.some((step) => step.action !== "unchanged" && step.kind === "agent");
  const pendingVaults = dryRun ? vaultSteps.filter((step) => step.kind === "vault" && step.action === "create").map((step) => step.key) : [];
  const taskSteps = scheduled
    ? await deployScheduled(instance, { client, lock, dryRun, log, saveLock, pendingAgent, pendingVaults })
    : [];

  const plan = [...skillSteps, ...steps, ...vaultSteps, ...taskSteps].map(({ file, kind, action, key, entry }): PlanEntry => ({
    file, kind, action,
    id: lock.resources[key]?.id ?? entry?.id,
    version: lock.resources[key]?.version,
  }));
  return { plan, lock };
}

// Makes a deployment for each task in scheduled/, pinned to the agent's version and with every
// deployed vault, then pauses or unpauses it to match `enabled`. A task whose file is gone has its
// deployment archived, because a schedule left behind would keep running, and costing money.
async function deployScheduled(
  instance: Instance,
  { client, lock, dryRun, log, saveLock, pendingAgent, pendingVaults }: StepOptions & { pendingAgent: boolean; pendingVaults: string[] },
): Promise<(TaskStep | ArchiveStep)[]> {
  const agentEntry = lock.resources[`./${AGENT_FILE}`];
  const envEntry = environmentEntry(lock);
  const agent: DeploymentBody["agent"] = { type: "agent", id: agentEntry?.id ?? "pending", version: pendingAgent || !agentEntry ? "pending" : Number(agentEntry.version) };
  const vaultIds = instance.vaults.map((vault) => lock.resources[vaultKey(vault)]?.id ?? (pendingVaults.includes(vaultKey(vault)) ? `pending:${vault.path}` : null)).filter(Boolean) as string[];

  const steps: (TaskStep | ArchiveStep)[] = [];
  for (const task of instance.scheduled) {
    const body: DeploymentBody = { ...taskBody(task), agent, environment_id: envEntry?.id ?? "pending", vault_ids: vaultIds };
    const paused = !taskSettings(task).enabled;
    const step: TaskStep = planStep(lock, { file: task.file, key: taskKey(task), kind: "deployment", body });
    step.isChanged = step.action === "update";
    if (step.action === "unchanged" && Boolean(step.entry!.paused) !== paused) step.action = paused ? "pause" : "unpause";
    steps.push(step);
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? task.name}`);
      continue;
    }

    let result = step.action === "create" ? null : await currentDeployment(client, step);
    const isReplacing = step.action !== "create" && !result;
    // Past a dry run, the agent and its environment are deployed, so body has no "pending" stand-ins.
    if (!result) result = await call(step, () => client.beta.deployments.create(body as DeploymentCreateParams));
    else if (step.isChanged) {
      // Updates keep any field they aren't sent, so a budget or description taken out of the file is cleared.
      result = await call(step, () => client.beta.deployments.update(result!.id, { ...body, budget: body.budget ?? null, description: body.description ?? null } as DeploymentUpdateParams));
    }
    // result is set by now; the callbacks below just can't see it narrowed.
    if (paused && result.status === "active") result = await call(step, () => client.beta.deployments.pause(result!.id));
    else if (!paused && result.status === "paused") result = await call(step, () => client.beta.deployments.unpause(result!.id));

    lock.resources[step.key] = { kind: "deployment", id: result.id, hash: step.hash, paused };
    await saveLock(lock);
    const nextRun = result.schedule?.upcoming_runs_at?.[0];
    const when = paused ? (step.action === "pause" ? null : "paused") : nextRun ? `next run ${nextRun}` : null;
    const done = isReplacing ? `replaced` : { create: "created", update: "updated", pause: "paused", unpause: "unpaused" }[step.action];
    log(`${done.padEnd(9)} deployment ${result.id}${isReplacing ? ` (${step.entry!.id} was archived)` : ""}${when ? ` (${when})` : ""}`);
  }

  const wanted = new Set(instance.scheduled.map(taskKey));
  for (const [key, entry] of Object.entries(lock.resources)) {
    if (entry.kind !== "deployment" || wanted.has(key)) continue;
    const step: ArchiveStep = { file: key.slice(2), key, kind: "deployment", action: "archive", entry };
    steps.push(step);
    if (dryRun) {
      log(`archive   deployment ${entry.id}`);
      continue;
    }
    await stopDeployment(client, step, "archive");
    delete lock.resources[key];
    await saveLock(lock);
    log(`archived  deployment ${entry.id} (${step.file} is gone)`);
  }
  return steps;
}

// A deployment as it is now, or null if it's been deleted or archived, which makes it unusable.
// `step` has the deployment's lock entry.
async function currentDeployment(client: Anthropic, step: StepRef): Promise<Anthropic.Beta.BetaManagedAgentsDeployment | null> {
  try {
    const remote = await client.beta.deployments.retrieve(step.entry!.id);
    return remote.archived_at ? null : remote;
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 404) return null;
    throw apiError(step, err);
  }
}

// Pauses or archives a deployment, unless it's already that way, or gone.
async function stopDeployment(client: Anthropic, step: StepRef, how: "pause" | "archive"): Promise<void> {
  const remote = await currentDeployment(client, step);
  if (!remote || (how === "pause" && remote.status === "paused")) return;
  await call(step, () => client.beta.deployments[how](remote.id));
}

// Pauses the deployment of every scheduled task in a lock, such as when a host takes the agent
// offline. The next deploy unpauses the ones whose files say they're enabled.
// (An entry means the lock and its resources are there, hence the !s.)
export async function pauseScheduled({ lock, client, saveLock = () => {} }: ScheduledLockOptions): Promise<void> {
  for (const [key, entry] of Object.entries(lock?.resources ?? {})) {
    if (entry.kind !== "deployment") continue;
    await stopDeployment(client, { file: key.slice(2), key, kind: "deployment", entry }, "pause");
    lock!.resources![key] = { ...entry, paused: true };
    await saveLock(lock!);
  }
}

// Archives the deployment of every scheduled task in a lock, for good, such as before a host deletes
// the agent. The next deploy makes new ones.
export async function archiveScheduled({ lock, client, saveLock = () => {} }: ScheduledLockOptions): Promise<void> {
  for (const [key, entry] of Object.entries(lock?.resources ?? {})) {
    if (entry.kind !== "deployment") continue;
    await stopDeployment(client, { file: key.slice(2), key, kind: "deployment", entry }, "archive");
    delete lock!.resources![key];
    await saveLock(lock!);
  }
}

// Reads claude-lock.json, or starts a new lock, and checks it was written for this API.
export const openLock = (dir: string, client: Pick<Anthropic, "baseURL">): PreparedLock => prepareLock(readLock(dir), client);

// The lock to deploy with: the one given, or a new one, after checking it's for this API.
export function prepareLock(previous: Lock | null | undefined, client: Pick<Anthropic, "baseURL">): PreparedLock {
  const baseURL = client.baseURL;
  // resources is filled in just below if it's missing.
  const lock = (previous ?? { version: 1, origin: { base_url: baseURL }, resources: {} }) as PreparedLock;
  lock.resources ??= {};
  upgradeLock(lock);
  if (lock.origin?.base_url && lock.origin.base_url !== baseURL) {
    throw new DeployError(
      `${LOCK_FILE} was written for ${lock.origin.base_url}, but this client uses ${baseURL}`,
    );
  }
  return lock;
}

// Uploads each skill that's new or changed. A change uploads the whole folder as a new version.
async function deploySkills(skills: Skill[], { client, lock, dryRun, log, saveLock }: StepOptions): Promise<SkillStep[]> {
  const steps: SkillStep[] = [];
  for (const skill of skills) {
    const step = planStep(lock, { file: skill.path, key: skillKey(skill), kind: "skill", body: skillFingerprint(skill) });
    steps.push(step);
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? skill.name}`);
      continue;
    }

    // The API keeps a skill's layout from these names, so each one starts with its folder.
    const files = await Promise.all(skill.files.map((f) => toFile(f.bytes, `${skill.name}/${f.rel}`)));
    let id: string;
    let version: string;
    if (step.action === "create") {
      const created = await call(step, () => client.skills.create({ files }));
      ({ id, latest_version_id: version } = created);
    } else {
      ({ id } = step.entry!);
      await retrieve(step, () => client.skills.retrieve(id));
      ({ id: version } = await call(step, () => client.skills.versions.create(id, { files })));
    }
    lock.resources[step.key] = { kind: "skill", id, version, hash: step.hash };
    await saveLock(lock);
    log(`${(step.action === "create" ? "created" : "updated").padEnd(9)} skill ${id} (version ${version})`);
  }
  return steps;
}

// Creates or updates each vault, then updates the settings of credentials already created.
// A credential file with no credential yet is reported, not created: that needs its secrets.
async function deployVaults(
  vaults: Vault[],
  { client, lock, dryRun, log, saveLock, pathOf }: StepOptions & { pathOf: (file: string) => string },
): Promise<(VaultStep | CredentialStep)[]> {
  const steps: (VaultStep | CredentialStep)[] = [];
  for (const vault of vaults) {
    const step = planStep(lock, { file: vault.path, key: vaultKey(vault), kind: "vault", body: vaultBody(vault) });
    steps.push(step);
    for (const cred of vault.credentials) {
      // cred and vaultStep are set just below.
      const credStep = planStep(lock, { file: cred.file, key: credentialKey(cred), kind: "credential", body: credentialSettings(cred) }) as CredentialStep;
      credStep.cred = cred;
      credStep.vaultStep = step;
      // A credential belongs to the vault it was created in; if that vault was replaced, it's gone.
      if (credStep.entry && credStep.entry.vault_id !== step.entry?.id) credStep.entry = undefined;
      if (!credStep.entry) credStep.action = "missing";
      steps.push(credStep);
    }
  }

  // Check every credential update first, so an immutable field changed in one file stops the
  // deploy before anything is sent.
  if (!dryRun) {
    for (const step of steps.filter((s): s is CredentialStep => s.kind === "credential" && s.action === "update")) {
      const remote = await retrieve(step, () => client.beta.vaults.credentials.retrieve(step.entry!.id, { vault_id: step.entry!.vault_id }));
      const changed = changedImmutableFields(step.cred, remote.auth);
      if (changed.length > 0) {
        throw new DeployError(
          `${step.file}: ${changed.map((f) => `\`auth.${f}\``).join(", ")} can't be changed on an existing credential. ` +
            `Delete it with \`agentschema cred delete ${pathOf(step.file)}\`, then create it again with \`agentschema cred deploy\`.`,
        );
      }
      step.remote = remote;
    }
  }

  for (const step of steps) {
    if (step.action === "missing") {
      log(`missing   credential ${step.file} (create it with: agentschema cred deploy ${pathOf(step.file)})`);
      continue;
    }
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? ""}`.trimEnd());
      continue;
    }

    // Past here, an update's step has its lock entry.
    let result: { id: string };
    if (step.kind === "vault") {
      if (step.action === "create") {
        result = await call(step, () => client.beta.vaults.create(step.body));
      } else {
        const remote = await retrieve(step, () => client.beta.vaults.retrieve(step.entry!.id));
        const body = { ...step.body, metadata: metadataWithDeletions(step.body.metadata, remote.metadata) };
        result = await call(step, () => client.beta.vaults.update(step.entry!.id, body));
      }
      lock.resources[step.key] = { kind: "vault", id: result.id, hash: step.hash };
    } else {
      result = await call(step, () => client.beta.vaults.credentials.update(step.entry!.id, credentialUpdateBody(step)));
      lock.resources[step.key] = { ...step.entry, hash: step.hash };
    }
    await saveLock(lock);
    log(`${(step.action === "create" ? "created" : "updated").padEnd(9)} ${step.kind} ${result.id}`);
  }
  return steps;
}

// Fills in a step's hash, lock entry and action, in place.
function planStep<K extends ResourceKind, B>(lock: PreparedLock, input: { file: string; key: string; kind: K; body: B }): Step<K, B> {
  const step = input as Step<K, B>;
  step.hash = hashBody(step.body);
  step.entry = lock.resources[step.key];
  if (step.entry && step.entry.kind !== step.kind) {
    throw new DeployError(`${LOCK_FILE}: entry for ${step.key} is a ${step.entry.kind}, expected ${step.kind}`);
  }
  step.action = !step.entry ? "create" : step.entry.hash === step.hash ? "unchanged" : "update";
  return step;
}

// Only a credential's name, metadata, refresh scope, networking and injection location can
// change; the immutable fields were checked to be unchanged, and the secrets stay as they are
// in the vault.
// `step` is an update, so it has its lock entry.
function credentialUpdateBody(step: CredentialStep): CredentialUpdateParams {
  const { display_name, auth, metadata } = step.body;
  const body: CredentialUpdateParams = {
    vault_id: step.entry!.vault_id,
    display_name,
    metadata: metadataWithDeletions(metadata, step.remote?.metadata),
  };
  if (auth.refresh) body.auth = { type: auth.type, refresh: { scope: auth.refresh.scope ?? null } };
  if (auth.type === ENV_VAR) {
    // An update keeps what it isn't sent, so spell out what the file means: when created,
    // no injection_location enables both, and a field left out of one is false.
    const where = auth.injection_location;
    body.auth = {
      type: auth.type,
      networking: auth.networking,
      injection_location: where ? { header: where.header === true, body: where.body === true } : { header: true, body: true },
    };
  }
  return body;
}

// The bodies are the files' frontmatter, which checkFiles checked has what the API requires.
async function deployEnvironment(client: Anthropic, step: InstanceStep): Promise<Anthropic.Beta.BetaEnvironment> {
  if (step.action === "create") return call(step, () => client.beta.environments.create(step.body as Anthropic.Beta.EnvironmentCreateParams));

  const { id } = step.entry!;
  const remote = await retrieve(step, () => client.beta.environments.retrieve(id));
  const body = { ...step.body };
  // Updates keep any field you omit, so clear what was removed from env.md.
  if (!("description" in body)) body.description = null;
  body.metadata = metadataWithDeletions(body.metadata, remote.metadata);
  return call(step, () => client.beta.environments.update(id, body));
}

async function deployAgent(client: Anthropic, step: InstanceStep, force: boolean): Promise<Anthropic.Beta.BetaManagedAgentsAgent> {
  if (step.action === "create") return call(step, () => client.beta.agents.create(step.body as Anthropic.Beta.AgentCreateParams));

  const { id, version } = step.entry!;
  const remote = await retrieve(step, () => client.beta.agents.retrieve(id));
  const body = { ...step.body };
  // Updates keep any field you omit, so clear what was removed from agent.md.
  if (!("system" in body)) body.system = null;
  for (const field of ["description", "multiagent"]) if (!(field in body)) body[field] = null;
  for (const field of ["tools", "mcp_servers", "skills"]) if (!(field in body)) body[field] = [];
  body.metadata = metadataWithDeletions(body.metadata, remote.metadata);
  // Sending the locked version makes the API refuse the update if someone changed the agent since.
  if (!force && version !== undefined) body.version = Number(version);

  try {
    return await client.beta.agents.update(id, body);
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 409) {
      throw new DeployError(
        `agent ${id} was changed outside this folder (${LOCK_FILE} has version ${version}, ` +
          `the agent is at version ${remote.version}). Re-run with --force to overwrite it.`,
      );
    }
    throw apiError(step, err);
  }
}

// Metadata updates merge, so keys removed from the file are sent as null to delete them.
export function metadataWithDeletions(
  local: Record<string, string | null> = {},
  remote: Record<string, unknown> | null = {},
): Record<string, string | null> {
  const merged = { ...local };
  for (const key of Object.keys(remote ?? {})) if (!(key in merged)) merged[key] = null;
  return merged;
}

// `step` has the resource's lock key and entry.
export async function retrieve<T extends object>(step: StepRef, fn: () => Promise<T>): Promise<T> {
  let remote: T;
  try {
    remote = await fn();
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 404) {
      throw new DeployError(
        `${step.kind} ${step.entry!.id} in ${LOCK_FILE} no longer exists. ` +
          `Remove the "${step.key}" entry from ${LOCK_FILE} to create a new one.`,
      );
    }
    throw apiError(step, err);
  }
  // Not every resource can be archived (skills can't), so not every type has archived_at.
  if ((remote as { archived_at?: string | null }).archived_at) {
    throw new DeployError(
      `${step.kind} ${step.entry!.id} is archived and can't be updated. ` +
        `Remove the "${step.key}" entry from ${LOCK_FILE} to create a new one.`,
    );
  }
  return remote;
}

export async function call<T>(step: StepRef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw apiError(step, err);
  }
}

function apiError(step: StepRef, err: unknown): unknown {
  if (!(err instanceof Anthropic.APIError)) return err;
  // The API's error body: { error: { type, message } }.
  const message = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
  return new DeployError(`${step.file}: the API rejected the ${step.kind} (${err.status ?? "network error"}): ${message}`);
}
