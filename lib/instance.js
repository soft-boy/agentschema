import { textOf } from "./files.js";
import { FileError, parseMarkdown } from "./markdown.js";
import { systemPromptOf } from "./system-prompt.js";
import { compileTools } from "./tools.js";

export const AGENT_FILE = "agent.md";
export const COMPUTER_FILE = "computer.md";
// computer.md's old name. A folder that still has it works, with a warning to rename it.
export const OLD_COMPUTER_FILE = "env.md";

// Reads agent.md and computer.md. Returns { agent, env, errors, warnings }; a file that can't be
// read is null and has an entry in errors. `env` is computer.md, the agent's environment, and its
// `file` says which name it was read from.
export function readInstance(files) {
  const names = Object.keys(files).filter((path) => !path.includes("/"));
  const errors = [];
  const warnings = [];
  const read = (name) => {
    try {
      // Exact names only, so an agent behaves the same on a case-sensitive file system.
      if (!names.includes(name)) {
        const wrongCase = names.find((n) => n.toLowerCase() === name);
        const hint = wrongCase ? ` (found ${wrongCase}; the name must be lowercase)` : "";
        throw new FileError(`${name}: missing${hint}`);
      }
      return parseMarkdown(textOf(files[name]), name);
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
      return null;
    }
  };
  const agent = read(AGENT_FILE);
  const hasOldName = names.includes(OLD_COMPUTER_FILE);
  const computerFile = hasOldName && !names.includes(COMPUTER_FILE) ? OLD_COMPUTER_FILE : COMPUTER_FILE;
  if (computerFile === OLD_COMPUTER_FILE) warnings.push(`${OLD_COMPUTER_FILE}: this is ${COMPUTER_FILE}'s old name; rename it to ${COMPUTER_FILE}`);
  else if (hasOldName) errors.push(`${OLD_COMPUTER_FILE}: this is ${COMPUTER_FILE}'s old name, and the folder has both; remove ${OLD_COMPUTER_FILE}`);
  const env = read(computerFile);
  return { agent, env: env && { ...env, file: computerFile }, errors, warnings };
}

// The bodies sent to POST /v1/agents and POST /v1/environments.
// The agent's tools come from tools/, compiled into the API's `tools` list. `skills` are the
// references to the skills deployed from skills/, added to any in agent.md's frontmatter. The system
// prompt is agent.md's body, then system_prompt/'s files.
// `options.toolsets` is the catalog behind `type: agentbook` tool files.
export function agentBody(instance, skills = [], options = {}) {
  const { agent, tools } = instance;
  const body = { ...agent.data, tools: compileTools(tools, options) };
  if (skills.length > 0) body.skills = [...(agent.data.skills ?? []), ...skills];
  const system = systemPromptOf(instance);
  if (system) body.system = system;
  return body;
}

export function envBody({ env }) {
  return { ...env.data };
}

// The lock's entry for the environment is under "./computer.md". A lock written before computer.md
// was renamed has it under "./env.md": environmentEntry finds it either way, and upgradeLock moves
// it, so the next deploy updates that environment rather than making another.
export const ENVIRONMENT_KEY = `./${COMPUTER_FILE}`;
const OLD_ENVIRONMENT_KEY = `./${OLD_COMPUTER_FILE}`;

export const environmentEntry = (lock) => lock?.resources?.[ENVIRONMENT_KEY] ?? lock?.resources?.[OLD_ENVIRONMENT_KEY];

export function upgradeLock(lock) {
  const resources = lock?.resources;
  if (resources?.[OLD_ENVIRONMENT_KEY] && !resources[ENVIRONMENT_KEY]) {
    resources[ENVIRONMENT_KEY] = resources[OLD_ENVIRONMENT_KEY];
    delete resources[OLD_ENVIRONMENT_KEY];
  }
  return lock;
}
