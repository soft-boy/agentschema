import { checkChannels, readChannels } from "./channels.js";
import { textOf } from "./files.js";
import { AGENT_FILE, ENV_FILE, readInstance } from "./instance.js";
import { checkScheduled, readScheduled } from "./scheduled.js";
import { SYSTEM_PROMPT_DIR, readSystemPrompt, systemPromptOf } from "./system-prompt.js";
import { MAX_UPLOAD_BYTES, SKILLS_DIR, readSkills } from "./skills.js";
import { MCP_TOOLSET, TOOLS_DIR, checkTools, readTools } from "./tools.js";
import { CREDENTIAL_TYPES, ENV_VAR, SECRET_FIELDS, TOKEN_ENDPOINT_AUTH, VAULT_FILE, get, readVaults } from "./vaults.js";

const AGENT_FIELDS = new Set([
  "name", "model", "description", "mcp_servers", "skills",
  "multiagent", "metadata", "execution_identity",
]);
const ENV_FIELDS = new Set(["name", "config", "description", "metadata", "scope"]);

const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "an Anthropic API key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[bpas]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{35}\b/, "a Telegram bot token"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "a SendGrid API key"],
  [/\b(AC|SK)[0-9a-f]{32}\b/, "a Twilio SID"],
  [/\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/, "a Discord bot token"],
];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Validates an agent's files without calling the API. `files` is a file map (see files.js), and
// `options` is what checkTools takes: { customTools, toolsets }.
// Returns { errors, warnings, instance }; instance is null when the files can't be read.
export function checkFiles(files, options = {}) {
  const { agent, env, errors } = readInstance(files);
  const { tools, errors: toolErrors } = readTools(files);
  const { vaults, errors: vaultErrors } = readVaults(files);
  const { skills, errors: skillErrors } = readSkills(files);
  const { channels, errors: channelErrors } = readChannels(files);
  const { tasks: scheduled, errors: scheduledErrors } = readScheduled(files);
  const { parts: systemPrompt, errors: systemPromptErrors } = readSystemPrompt(files);
  errors.push(...toolErrors, ...vaultErrors, ...skillErrors, ...channelErrors, ...scheduledErrors, ...systemPromptErrors);
  const warnings = [];

  if (agent) checkAgent(agent, errors, warnings);
  if (agent) checkSystemPromptLength({ agent, systemPrompt }, errors);
  if (env) checkEnv(env, errors, warnings);
  checkTools(tools, errors, warnings, options);
  if (agent) checkMcpServers(agent, tools, errors);
  if (agent && env) checkMcpNetworking(agent, env, warnings);
  for (const skill of skills) checkSkill(skill, errors);
  const declaredSkills = Array.isArray(agent?.data.skills) ? agent.data.skills.length : 0;
  if (declaredSkills + skills.length > 500) errors.push(`${declaredSkills + skills.length} skills; the limit is 500`);
  for (const vault of vaults) checkVault(vault, errors, warnings);
  checkEnvVarCredentials(vaults, env, warnings);
  checkChannels(channels, { agent: agent ?? undefined, systemPrompt, tools, toolsets: options.toolsets }, errors, warnings);
  checkScheduled(scheduled, { tools }, errors, warnings);

  const vaultFiles = vaults.flatMap((v) => [...(v.file ? [[`${v.path}/${VAULT_FILE}`, v.file]] : []), ...v.credentials.map((c) => [c.file, c])]);
  const skillTexts = skills.flatMap((s) => s.files.map((f) => [`${s.path}/${f.rel}`, { raw: textOf(f.bytes) }]));
  for (const [file, parsed] of [[AGENT_FILE, agent], [ENV_FILE, env], ...tools.map((t) => [t.file, t]), ...vaultFiles, ...skillTexts, ...channels.map((c) => [c.file, c]), ...scheduled.map((t) => [t.file, t]), ...systemPrompt.map((p) => [p.file, { raw: p.text }])]) {
    if (!parsed) continue;
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(parsed.raw)) errors.push(`${file}: looks like it contains ${what}; keep secrets out of these files`);
    }
  }

  return { errors, warnings, instance: agent && env ? { agent, env, tools, vaults, skills, channels, scheduled, systemPrompt } : null };
}

const MAX_SYSTEM_PROMPT = 100_000;

// The system prompt is agent.md's body and system_prompt/'s files together, and the API's limit is on
// all of it.
function checkSystemPromptLength(instance, errors) {
  const { length } = systemPromptOf(instance);
  if (length <= MAX_SYSTEM_PROMPT) return;
  const where = instance.systemPrompt.length > 0 ? `${AGENT_FILE} and ${SYSTEM_PROMPT_DIR}/` : AGENT_FILE;
  errors.push(`${where}: the system prompt is ${length.toLocaleString("en-US")} characters; the limit is ${MAX_SYSTEM_PROMPT.toLocaleString("en-US")}`);
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

  if (data.description !== undefined && data.description !== null) {
    if (typeof data.description !== "string") err("`description` must be a string");
    else if (data.description.length > 2048) err("`description` must be at most 2048 characters");
  }

  if ("tools" in data) err(`\`tools\` is not allowed in frontmatter; define each tool as a file in ${TOOLS_DIR}/`);

  for (const [field, max] of [["mcp_servers", 20], ["skills", 500]]) {
    if (data[field] === undefined) continue;
    if (!Array.isArray(data[field])) err(`\`${field}\` must be a list`);
    else if (data[field].length > max) err(`\`${field}\` has ${data[field].length} entries; the limit is ${max}`);
  }

  if (Array.isArray(data.skills)) {
    for (const [index, skill] of data.skills.entries()) checkSkillRef(skill, (msg) => err(`\`skills[${index}]\`: ${msg}`));
  }

  checkMetadata(data.metadata, 16, err);

  for (const key of Object.keys(data)) {
    if (!AGENT_FIELDS.has(key) && key !== "system" && key !== "tools") {
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

// An entry in agent.md's `skills` list, in the API's shape.
function checkSkillRef(skill, err) {
  if (typeof skill === "string") {
    return err(`write this as a mapping with \`type\` and \`skill_id\`; a skill in ${SKILLS_DIR}/ is attached without being listed`);
  }
  if (!isObject(skill)) return err("must be a mapping with `type` and `skill_id`");
  if (!["anthropic", "custom"].includes(skill.type)) err("`type` must be `anthropic` or `custom`");
  if (typeof skill.skill_id !== "string" || skill.skill_id === "") err("`skill_id` is required");
  else if (skill.type === "custom" && !skill.skill_id.startsWith("skill_")) err("a custom skill's `skill_id` starts with skill_");
  if (skill.version !== undefined && skill.version !== null && typeof skill.version !== "string") {
    err("`version` must be a string (quote numbers)");
  }
}

function checkSkill(skill, errors) {
  const err = (msg) => errors.push(`${skill.file}: ${msg}`);
  const { name, description } = skill.data;
  if (typeof name !== "string" || name === "") err("`name` is required");
  else {
    if (name !== skill.name) err(`\`name\` must match the folder's name (${skill.name})`);
    if (!/^[a-z0-9-]{1,64}$/.test(name)) err("`name` may only use lowercase letters, digits and hyphens, up to 64 characters");
    if (/anthropic|claude/.test(name)) err("`name` can't contain the reserved words `anthropic` or `claude`");
  }
  if (typeof description !== "string" || description.trim() === "") err("`description` is required");
  else {
    if (description.length > 1024) err(`\`description\` is ${description.length} characters; the limit is 1,024`);
    if (/<[^>]+>/.test(description)) err("`description` can't contain XML tags");
  }
  const size = skill.files.reduce((total, f) => total + f.bytes.length, 0);
  if (size > MAX_UPLOAD_BYTES) errors.push(`${skill.path}: its files add up to ${Math.ceil(size / 1024 / 1024)} MB; the limit is 30 MB`);
}

const mcpServers = (agent) => (Array.isArray(agent.data.mcp_servers) ? agent.data.mcp_servers.filter(isObject) : []);

// Each server agent.md declares needs a toolset file, and each toolset file a declared server;
// the API rejects an agent otherwise.
function checkMcpServers(agent, tools, errors) {
  const err = (msg) => errors.push(`${AGENT_FILE}: ${msg}`);
  const names = new Set();
  for (const server of mcpServers(agent)) {
    const label = typeof server.name === "string" && server.name ? `\`${server.name}\`` : "an entry";
    if (server.type !== "url") err(`\`mcp_servers\`: ${label} must have \`type: url\``);
    if (typeof server.name !== "string" || server.name === "" || server.name.length > 255) {
      err("`mcp_servers`: each server needs a `name` of 1 to 255 characters");
    } else if (names.has(server.name)) {
      err(`\`mcp_servers\`: \`${server.name}\` is declared twice`);
    }
    if (typeof server.url !== "string" || !/^https?:\/\/\S+$/.test(server.url) || server.url.length > 2048) {
      err(`\`mcp_servers\`: ${label} needs a \`url\`, an http(s) URL of at most 2048 characters`);
    }
    names.add(server.name);
  }

  const toolsets = tools.filter((t) => t.data.type === MCP_TOOLSET);
  const covered = new Set(toolsets.map((t) => t.data.mcp_server_name));
  for (const name of names) {
    if (typeof name === "string" && name && !covered.has(name)) {
      err(`\`mcp_servers\`: \`${name}\` has no toolset; add ${TOOLS_DIR}/${name}.md with \`type: mcp_toolset\`, or the API rejects the agent`);
    }
  }
  for (const toolset of toolsets) {
    const name = toolset.data.mcp_server_name;
    if (typeof name === "string" && name && !names.has(name)) {
      errors.push(`${toolset.file}: \`${name}\` isn't in ${AGENT_FILE}'s \`mcp_servers\``);
    }
  }
}

// A limited network blocks MCP servers that aren't allowed, and the API then refuses to start sessions.
function checkMcpNetworking(agent, env, warnings) {
  const net = env.data.config?.networking;
  if (net?.type !== "limited" || net.allow_mcp_servers === true) return;
  const allowed = net.allowed_hosts ?? [];
  for (const server of mcpServers(agent)) {
    let host;
    try {
      host = new URL(server.url).host;
    } catch {
      continue;
    }
    if (!allowed.includes(host)) {
      warnings.push(
        `${ENV_FILE}: its limited networking doesn't allow MCP server \`${server.name}\` (${host}), so sessions won't start; ` +
          `set config.networking.allow_mcp_servers to true, or add ${host} to allowed_hosts`,
      );
    }
  }
}

function checkVault(vault, errors, warnings) {
  if (vault.name.length > 255) errors.push(`${vault.path}: a vault's name (its folder name) must be at most 255 characters`);

  if (vault.file) {
    const file = `${vault.path}/${VAULT_FILE}`;
    const err = (msg) => errors.push(`${file}: ${msg}`);
    const { data } = vault.file;
    if ("display_name" in data) err("`display_name` is not allowed; the folder name is the vault's name");
    checkMetadata(data.metadata, 16, err);
    for (const key of Object.keys(data)) {
      if (key !== "metadata" && key !== "display_name") warnings.push(`${file}: unknown field \`${key}\` will be sent to the API as written`);
    }
  }

  if (vault.credentials.length > 20) errors.push(`${vault.path}: ${vault.credentials.length} credentials; a vault holds at most 20`);
  const urls = new Map();
  const secretNames = new Map();
  for (const cred of vault.credentials) {
    checkCredential(cred, errors, warnings);
    const url = cred.data.auth?.mcp_server_url;
    if (typeof url === "string") {
      if (urls.has(url)) errors.push(`${cred.file}: ${urls.get(url)} is already a credential for ${url}; a vault holds one per server`);
      else urls.set(url, cred.file);
    }
    const secretName = cred.data.auth?.secret_name;
    if (typeof secretName === "string") {
      if (secretNames.has(secretName)) errors.push(`${cred.file}: ${secretNames.get(secretName)} already sets ${secretName}; a vault holds one per variable`);
      else secretNames.set(secretName, cred.file);
    }
  }
}

// What an environment variable credential depends on outside its own file.
function checkEnvVarCredentials(vaults, env, warnings) {
  const creds = vaults.flatMap((v) => v.credentials).filter((c) => c.data.auth?.type === ENV_VAR);
  const net = env?.data.config?.networking;
  const seen = new Map();
  for (const cred of creds) {
    const warn = (msg) => warnings.push(`${cred.file}: ${msg}`);
    const { secret_name: name, networking } = cred.data.auth;

    // Two vaults can both set a variable, but the docs don't say which one wins.
    if (typeof name === "string") {
      if (seen.has(name) && seen.get(name).vault !== cred.vault) warn(`${seen.get(name).file} also sets ${name}, and the API doesn't document which vault wins`);
      else seen.set(name, cred);
    }

    if (env?.data.config?.type === "self_hosted") warn("environment variable credentials aren't supported on self-hosted environments yet");

    // allowed_hosts only decides where the secret is substituted; the environment decides what's reachable.
    if (net?.type === "limited" && networking?.type === "limited" && Array.isArray(networking.allowed_hosts)) {
      for (const host of networking.allowed_hosts) {
        if (!(net.allowed_hosts ?? []).includes(host)) {
          warn(`${ENV_FILE}'s limited networking doesn't allow ${host}, so requests to it will be blocked; add it to allowed_hosts in ${ENV_FILE}`);
        }
      }
    }
  }
}

function checkCredential(cred, errors, warnings) {
  const err = (msg) => errors.push(`${cred.file}: ${msg}`);
  const warn = (msg) => warnings.push(`${cred.file}: ${msg}`);
  const { data } = cred;
  if (cred.name.length > 255) err("a credential's name (its file name) must be at most 255 characters");
  if ("display_name" in data) err("`display_name` is not allowed; the file name is the credential's name");
  checkMetadata(data.metadata, 16, err);
  for (const key of Object.keys(data)) {
    if (!["auth", "metadata", "display_name"].includes(key)) warn(`unknown field \`${key}\` will be sent to the API as written`);
  }

  const { auth } = data;
  if (!isObject(auth)) return err("`auth` is required");
  if (!CREDENTIAL_TYPES.includes(auth.type)) return err(`\`auth.type\` must be ${CREDENTIAL_TYPES.map((t) => `\`${t}\``).join(" or ")}; other credential types aren't supported yet`);

  for (const path of SECRET_FIELDS[auth.type]) {
    if (get(auth, path) !== undefined) {
      err(`\`auth.${path.join(".")}\` doesn't go in the file; \`agentschema cred deploy\` asks for it and sends it straight to the vault`);
    }
  }

  if (auth.type === ENV_VAR) return checkEnvVarAuth(auth, err, warn);

  const url = (value, field) => {
    if (typeof value !== "string" || value === "") return err(`\`${field}\` is required`);
    if (!/^https?:\/\/\S+$/.test(value)) err(`\`${field}\` must be an http(s) URL`);
  };
  url(auth.mcp_server_url, "auth.mcp_server_url");
  for (const key of Object.keys(auth)) {
    if (!["type", "mcp_server_url", "refresh", "access_token", "expires_at"].includes(key)) {
      warn(`unknown field \`auth.${key}\` will be sent to the API as written`);
    }
  }

  if (auth.refresh === undefined || auth.refresh === null) return;
  const { refresh } = auth;
  if (!isObject(refresh)) return err("`auth.refresh` must be a mapping");
  url(refresh.token_endpoint, "auth.refresh.token_endpoint");
  if (typeof refresh.client_id !== "string" || refresh.client_id === "") err("`auth.refresh.client_id` is required, as a string (quote it if it looks like a number)");
  for (const field of ["scope", "resource"]) {
    if (refresh[field] !== undefined && typeof refresh[field] !== "string") err(`\`auth.refresh.${field}\` must be a string`);
  }
  if (!isObject(refresh.token_endpoint_auth) || !TOKEN_ENDPOINT_AUTH.includes(refresh.token_endpoint_auth.type)) {
    err(`\`auth.refresh.token_endpoint_auth.type\` must be ${TOKEN_ENDPOINT_AUTH.map((t) => `\`${t}\``).join(", ")}`);
  }
  for (const key of Object.keys(refresh)) {
    if (!["token_endpoint", "client_id", "scope", "resource", "token_endpoint_auth", "refresh_token"].includes(key)) {
      warn(`unknown field \`auth.refresh.${key}\` will be sent to the API as written`);
    }
  }
}

function checkEnvVarAuth(auth, err, warn) {
  if (typeof auth.secret_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.secret_name)) {
    err("`auth.secret_name` is required, and must be a variable name like STRIPE_API_KEY");
  }

  const { networking: net, injection_location: where } = auth;
  if (!isObject(net) || !["limited", "unrestricted"].includes(net.type)) {
    err("`auth.networking.type` is required, and must be `limited` or `unrestricted`");
  } else if (net.type === "unrestricted") {
    warn("`auth.networking` is `unrestricted`, so the secret is substituted on requests to any host; a prompt-injected agent could send it anywhere");
  } else if (!Array.isArray(net.allowed_hosts) || net.allowed_hosts.length === 0 || net.allowed_hosts.some((h) => typeof h !== "string" || h === "")) {
    err("`auth.networking.allowed_hosts` must list the hosts the secret may be sent to");
  }

  if (where !== undefined && where !== null) {
    if (!isObject(where)) err("`auth.injection_location` must be a mapping");
    else {
      for (const field of ["header", "body"]) {
        if (where[field] !== undefined && typeof where[field] !== "boolean") err(`\`auth.injection_location.${field}\` must be true or false`);
      }
      if (where.header !== true && where.body !== true) err("`auth.injection_location` must enable `header` or `body`; a field you leave out is false");
    }
  }

  for (const key of Object.keys(auth)) {
    if (!["type", "secret_name", "secret_value", "networking", "injection_location"].includes(key)) {
      warn(`unknown field \`auth.${key}\` will be sent to the API as written`);
    }
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
