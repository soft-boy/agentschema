import { AGENT_FILE, ENV_FILE, readInstance } from "./instance.js";

const AGENT_FIELDS = new Set([
  "name", "model", "description", "tools", "mcp_servers", "skills",
  "multiagent", "metadata", "execution_identity",
]);
const ENV_FIELDS = new Set(["name", "config", "description", "metadata", "scope"]);

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "an Anthropic API key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[bpas]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Validates an instance folder without calling the API.
// Returns { errors, warnings, instance }; instance is null when the files can't be read.
export function check(dir) {
  const { agent, env, errors } = readInstance(dir);
  const warnings = [];

  if (agent) checkAgent(agent, errors, warnings);
  if (env) checkEnv(env, errors, warnings);
  for (const [file, parsed] of [[AGENT_FILE, agent], [ENV_FILE, env]]) {
    if (!parsed) continue;
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(parsed.raw)) errors.push(`${file}: looks like it contains ${what}; keep secrets out of these files`);
    }
  }

  return { errors, warnings, instance: agent && env ? { agent, env } : null };
}

function checkAgent({ data, body }, errors, warnings) {
  const err = (msg) => errors.push(`${AGENT_FILE}: ${msg}`);

  if (typeof data.name !== "string" || data.name.trim() === "") err("`name` is required");
  else if (data.name.length > 256) err("`name` must be at most 256 characters");

  if (data.model === undefined) err("`model` is required");
  else if (isObject(data.model) ? typeof data.model.id !== "string" : typeof data.model !== "string") {
    err("`model` must be a model ID, or a mapping with an `id`");
  }

  if ("system" in data) err("`system` is not allowed in frontmatter; the Markdown body is the system prompt");
  if (body.length > 100_000) err(`system prompt is ${body.length} characters; the limit is 100,000`);

  if (data.description !== undefined && data.description !== null) {
    if (typeof data.description !== "string") err("`description` must be a string");
    else if (data.description.length > 2048) err("`description` must be at most 2048 characters");
  }

  for (const [field, max] of [["tools", 256], ["mcp_servers", 20], ["skills", 500]]) {
    if (data[field] === undefined) continue;
    if (!Array.isArray(data[field])) err(`\`${field}\` must be a list`);
    else if (data[field].length > max) err(`\`${field}\` has ${data[field].length} entries; the limit is ${max}`);
  }

  checkMetadata(data.metadata, 16, err);

  for (const key of Object.keys(data)) {
    if (!AGENT_FIELDS.has(key) && key !== "system") {
      warnings.push(`${AGENT_FILE}: unknown field \`${key}\` will be sent to the API as written`);
    }
  }
}

function checkEnv({ data }, errors, warnings) {
  const err = (msg) => errors.push(`${ENV_FILE}: ${msg}`);

  if (typeof data.name !== "string" || data.name.trim() === "") err("`name` is required");

  if (data.config !== undefined) {
    const { config } = data;
    if (!isObject(config)) err("`config` must be a mapping");
    else {
      if (!["cloud", "self_hosted"].includes(config.type)) err("`config.type` must be `cloud` or `self_hosted`");
      const net = config.networking;
      if (net !== undefined && !(isObject(net) && ["limited", "unrestricted"].includes(net.type))) {
        err("`config.networking.type` must be `limited` or `unrestricted`");
      }
    }
  }

  if (data.description !== undefined && data.description !== null && typeof data.description !== "string") {
    err("`description` must be a string");
  }

  checkMetadata(data.metadata, Infinity, err);

  for (const key of Object.keys(data)) {
    if (!ENV_FIELDS.has(key)) warnings.push(`${ENV_FILE}: unknown field \`${key}\` will be sent to the API as written`);
  }
}

function checkMetadata(metadata, maxKeys, err) {
  if (metadata === undefined) return;
  if (!isObject(metadata)) return err("`metadata` must be a mapping");
  const keys = Object.keys(metadata);
  if (keys.length > maxKeys) err(`\`metadata\` has ${keys.length} keys; the limit is ${maxKeys}`);
  for (const key of keys) {
    if (typeof metadata[key] !== "string") err(`\`metadata.${key}\` must be a string (quote numbers and booleans)`);
  }
}
