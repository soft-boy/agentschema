import { join } from "node:path";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { CHANNELS_DIR, readChannels } from "../lib/channels.js";
import { checkFiles } from "../lib/check.js";
import { AGENT_FILE, ENVIRONMENT_KEY, agentBody, envBody, environmentEntry, upgradeLock } from "../lib/instance.js";
import { taskBody, taskKey, taskSettings } from "../lib/scheduled.js";
import { skillKey, skillRefs } from "../lib/skills.js";
import { AGENTBOOK } from "../lib/tools.js";
import { ENV_VAR, changedImmutableFields, credentialKey, credentialSettings, vaultBody, vaultKey } from "../lib/vaults.js";
import { folderProblem, readFolder } from "./folder.js";
import { LOCK_FILE, hashBody, readLock, skillFingerprint, writeLock } from "./lock.js";

export class DeployError extends Error {}

// Deploys an agent folder, keeping the lock in its claude-lock.json. Returns the plan: one
// { file, kind, action, id, version } entry per resource.
export async function deploy(dir, { client, dryRun = false, force = false, log = () => {} }) {
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
}) {
  const { errors, instance } = checkFiles(files, checkOptions);
  if (errors.length > 0) throw new DeployError(`check failed:\n  ${errors.join("\n  ")}`);
  const agentbook = instance.tools.find((t) => t.data.type === AGENTBOOK);
  if (agentbook && !checkOptions.toolsets) {
    throw new DeployError(`${agentbook.file}: this toolset runs on agentbook, so it can only be deployed from there`);
  }
  const lock = prepareLock(previous, client);

  const skillSteps = await deploySkills(instance.skills, { client, lock, dryRun, log, saveLock });
  // A dry run has no new IDs or versions yet, so a stand-in shows that the agent will change too.
  const pending = dryRun ? skillSteps.filter((s) => s.action !== "unchanged") : [];
  const refs = instance.skills.flatMap((skill) => {
    const step = pending.find((s) => s.key === skillKey(skill));
    if (!step) return skillRefs([skill], lock);
    return [{ type: "custom", skill_id: step.entry?.id ?? `pending:${skill.name}`, version: `pending:${step.hash}` }];
  });

  const steps = [
    { file: instance.env.file, key: ENVIRONMENT_KEY, kind: "environment", body: envBody(instance) },
    { file: AGENT_FILE, key: `./${AGENT_FILE}`, kind: "agent", body: agentBody(instance, refs, checkOptions) },
  ];
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
    const result = step.kind === "environment"
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

  const plan = [...skillSteps, ...steps, ...vaultSteps, ...taskSteps].map(({ file, kind, action, key, entry }) => ({
    file, kind, action,
    id: lock.resources[key]?.id ?? entry?.id,
    version: lock.resources[key]?.version,
  }));
  return { plan, lock };
}

// Makes a deployment for each task in scheduled/, pinned to the agent's version and with every
// deployed vault, then pauses or unpauses it to match `enabled`. A task whose file is gone has its
// deployment archived, because a schedule left behind would keep running, and costing money.
async function deployScheduled(instance, { client, lock, dryRun, log, saveLock, pendingAgent, pendingVaults }) {
  const agentEntry = lock.resources[`./${AGENT_FILE}`];
  const envEntry = environmentEntry(lock);
  const agent = { type: "agent", id: agentEntry?.id ?? "pending", version: pendingAgent || !agentEntry ? "pending" : Number(agentEntry.version) };
  const vaultIds = instance.vaults.map((vault) => lock.resources[vaultKey(vault)]?.id ?? (pendingVaults.includes(vaultKey(vault)) ? `pending:${vault.path}` : null)).filter(Boolean);

  const steps = [];
  for (const task of instance.scheduled) {
    const body = { ...taskBody(task), agent, environment_id: envEntry?.id ?? "pending", vault_ids: vaultIds };
    const paused = !taskSettings(task).enabled;
    const step = planStep(lock, { file: task.file, key: taskKey(task), kind: "deployment", body });
    step.isChanged = step.action === "update";
    if (step.action === "unchanged" && Boolean(step.entry.paused) !== paused) step.action = paused ? "pause" : "unpause";
    steps.push(step);
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? task.name}`);
      continue;
    }

    let result = step.action === "create" ? null : await currentDeployment(client, step);
    const isReplacing = step.action !== "create" && !result;
    if (!result) result = await call(step, () => client.beta.deployments.create(body));
    else if (step.isChanged) {
      // Updates keep any field they aren't sent, so a budget or description taken out of the file is cleared.
      result = await call(step, () => client.beta.deployments.update(result.id, { ...body, budget: body.budget ?? null, description: body.description ?? null }));
    }
    if (paused && result.status === "active") result = await call(step, () => client.beta.deployments.pause(result.id));
    else if (!paused && result.status === "paused") result = await call(step, () => client.beta.deployments.unpause(result.id));

    lock.resources[step.key] = { kind: "deployment", id: result.id, hash: step.hash, paused };
    await saveLock(lock);
    const nextRun = result.schedule?.upcoming_runs_at?.[0];
    const when = paused ? (step.action === "pause" ? null : "paused") : nextRun ? `next run ${nextRun}` : null;
    const done = isReplacing ? `replaced` : { create: "created", update: "updated", pause: "paused", unpause: "unpaused" }[step.action];
    log(`${done.padEnd(9)} deployment ${result.id}${isReplacing ? ` (${step.entry.id} was archived)` : ""}${when ? ` (${when})` : ""}`);
  }

  const wanted = new Set(instance.scheduled.map(taskKey));
  for (const [key, entry] of Object.entries(lock.resources)) {
    if (entry.kind !== "deployment" || wanted.has(key)) continue;
    const step = { file: key.slice(2), key, kind: "deployment", action: "archive", entry };
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
async function currentDeployment(client, step) {
  try {
    const remote = await client.beta.deployments.retrieve(step.entry.id);
    return remote.archived_at ? null : remote;
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 404) return null;
    throw apiError(step, err);
  }
}

// Pauses or archives a deployment, unless it's already that way, or gone.
async function stopDeployment(client, step, how) {
  const remote = await currentDeployment(client, step);
  if (!remote || (how === "pause" && remote.status === "paused")) return;
  await call(step, () => client.beta.deployments[how](remote.id));
}

// Pauses the deployment of every scheduled task in a lock, such as when a host takes the agent
// offline. The next deploy unpauses the ones whose files say they're enabled.
export async function pauseScheduled({ lock, client, saveLock = () => {} }) {
  for (const [key, entry] of Object.entries(lock?.resources ?? {})) {
    if (entry.kind !== "deployment") continue;
    await stopDeployment(client, { file: key.slice(2), key, kind: "deployment", entry }, "pause");
    lock.resources[key] = { ...entry, paused: true };
    await saveLock(lock);
  }
}

// Archives the deployment of every scheduled task in a lock, for good, such as before a host deletes
// the agent. The next deploy makes new ones.
export async function archiveScheduled({ lock, client, saveLock = () => {} }) {
  for (const [key, entry] of Object.entries(lock?.resources ?? {})) {
    if (entry.kind !== "deployment") continue;
    await stopDeployment(client, { file: key.slice(2), key, kind: "deployment", entry }, "archive");
    delete lock.resources[key];
    await saveLock(lock);
  }
}

// Reads claude-lock.json, or starts a new lock, and checks it was written for this API.
export const openLock = (dir, client) => prepareLock(readLock(dir), client);

// The lock to deploy with: the one given, or a new one, after checking it's for this API.
export function prepareLock(previous, client) {
  const baseURL = client.baseURL;
  const lock = previous ?? { version: 1, origin: { base_url: baseURL }, resources: {} };
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
async function deploySkills(skills, { client, lock, dryRun, log, saveLock }) {
  const steps = [];
  for (const skill of skills) {
    const step = planStep(lock, { file: skill.path, key: skillKey(skill), kind: "skill", body: skillFingerprint(skill) });
    steps.push(step);
    if (dryRun || step.action === "unchanged") {
      log(`${step.action.padEnd(9)} ${step.kind} ${step.entry?.id ?? skill.name}`);
      continue;
    }

    // The API keeps a skill's layout from these names, so each one starts with its folder.
    const files = await Promise.all(skill.files.map((f) => toFile(f.bytes, `${skill.name}/${f.rel}`)));
    let id;
    let version;
    if (step.action === "create") {
      const created = await call(step, () => client.skills.create({ files }));
      ({ id, latest_version_id: version } = created);
    } else {
      ({ id } = step.entry);
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
async function deployVaults(vaults, { client, lock, dryRun, log, saveLock, pathOf }) {
  const steps = [];
  for (const vault of vaults) {
    const step = planStep(lock, { file: vault.path, key: vaultKey(vault), kind: "vault", body: vaultBody(vault) });
    steps.push(step);
    for (const cred of vault.credentials) {
      const credStep = planStep(lock, { file: cred.file, key: credentialKey(cred), kind: "credential", body: credentialSettings(cred) });
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
    for (const step of steps.filter((s) => s.kind === "credential" && s.action === "update")) {
      const remote = await retrieve(step, () => client.beta.vaults.credentials.retrieve(step.entry.id, { vault_id: step.entry.vault_id }));
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

    let result;
    if (step.kind === "vault") {
      if (step.action === "create") {
        result = await call(step, () => client.beta.vaults.create(step.body));
      } else {
        const remote = await retrieve(step, () => client.beta.vaults.retrieve(step.entry.id));
        const body = { ...step.body, metadata: metadataWithDeletions(step.body.metadata, remote.metadata) };
        result = await call(step, () => client.beta.vaults.update(step.entry.id, body));
      }
      lock.resources[step.key] = { kind: "vault", id: result.id, hash: step.hash };
    } else {
      result = await call(step, () => client.beta.vaults.credentials.update(step.entry.id, credentialUpdateBody(step)));
      lock.resources[step.key] = { ...step.entry, hash: step.hash };
    }
    await saveLock(lock);
    log(`${(step.action === "create" ? "created" : "updated").padEnd(9)} ${step.kind} ${result.id}`);
  }
  return steps;
}

function planStep(lock, step) {
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
function credentialUpdateBody(step) {
  const { display_name, auth, metadata } = step.body;
  const body = {
    vault_id: step.entry.vault_id,
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

async function deployEnvironment(client, step) {
  if (step.action === "create") return call(step, () => client.beta.environments.create(step.body));

  const { id } = step.entry;
  const remote = await retrieve(step, () => client.beta.environments.retrieve(id));
  const body = { ...step.body };
  // Updates keep any field you omit, so clear what was removed from env.md.
  if (!("description" in body)) body.description = null;
  body.metadata = metadataWithDeletions(body.metadata, remote.metadata);
  return call(step, () => client.beta.environments.update(id, body));
}

async function deployAgent(client, step, force) {
  if (step.action === "create") return call(step, () => client.beta.agents.create(step.body));

  const { id, version } = step.entry;
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
export function metadataWithDeletions(local = {}, remote = {}) {
  const merged = { ...local };
  for (const key of Object.keys(remote ?? {})) if (!(key in merged)) merged[key] = null;
  return merged;
}

export async function retrieve(step, fn) {
  let remote;
  try {
    remote = await fn();
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 404) {
      throw new DeployError(
        `${step.kind} ${step.entry.id} in ${LOCK_FILE} no longer exists. ` +
          `Remove the "${step.key}" entry from ${LOCK_FILE} to create a new one.`,
      );
    }
    throw apiError(step, err);
  }
  if (remote.archived_at) {
    throw new DeployError(
      `${step.kind} ${step.entry.id} is archived and can't be updated. ` +
        `Remove the "${step.key}" entry from ${LOCK_FILE} to create a new one.`,
    );
  }
  return remote;
}

export async function call(step, fn) {
  try {
    return await fn();
  } catch (err) {
    throw apiError(step, err);
  }
}

function apiError(step, err) {
  if (!(err instanceof Anthropic.APIError)) return err;
  const message = err.error?.error?.message ?? err.message;
  return new DeployError(`${step.file}: the API rejected the ${step.kind} (${err.status ?? "network error"}): ${message}`);
}
