import Anthropic from "@anthropic-ai/sdk";
import { check } from "./check.js";
import { AGENT_FILE, ENV_FILE, agentBody, envBody } from "./instance.js";
import { LOCK_FILE, hashBody, readLock, writeLock } from "./lock.js";

export class DeployError extends Error {}

// Creates or updates the environment and agent a folder defines, recording their IDs in claude-lock.json.
// Returns the plan: one { file, kind, action, id, version } entry per resource.
export async function deploy(dir, { client, dryRun = false, force = false, log = () => {} }) {
  const { errors, instance } = check(dir);
  if (errors.length > 0) throw new DeployError(`check failed:\n  ${errors.join("\n  ")}`);

  const baseURL = client.baseURL;
  const lock = readLock(dir) ?? { version: 1, origin: { base_url: baseURL }, resources: {} };
  lock.resources ??= {};
  if (lock.origin?.base_url && lock.origin.base_url !== baseURL) {
    throw new DeployError(
      `${LOCK_FILE} was written for ${lock.origin.base_url}, but this client uses ${baseURL}`,
    );
  }

  const steps = [
    { file: ENV_FILE, kind: "environment", body: envBody(instance.env) },
    { file: AGENT_FILE, kind: "agent", body: agentBody(instance.agent) },
  ];
  for (const step of steps) {
    step.key = `./${step.file}`;
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
    writeLock(dir, lock);

    const version = step.kind === "agent" ? ` (version ${result.version})` : "";
    log(`${(step.action === "create" ? "created" : "updated").padEnd(9)} ${step.kind} ${result.id}${version}`);
  }

  return steps.map(({ file, kind, action, key }) => ({
    file, kind, action,
    id: lock.resources[key]?.id,
    version: lock.resources[key]?.version,
  }));
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
function metadataWithDeletions(local = {}, remote = {}) {
  const merged = { ...local };
  for (const key of Object.keys(remote ?? {})) if (!(key in merged)) merged[key] = null;
  return merged;
}

async function retrieve(step, fn) {
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

async function call(step, fn) {
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
