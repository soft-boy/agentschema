import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileError, parseMarkdown } from "./markdown.js";
import { compileTools } from "./tools.js";

export const AGENT_FILE = "agent.md";
export const ENV_FILE = "env.md";

export { FileError, parseMarkdown };

// Reads agent.md and env.md from an instance folder.
// Returns { agent, env, errors }; a file that can't be read is null and has an entry in errors.
export function readInstance(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return { agent: null, env: null, errors: [`${dir}: no such directory`] };
  }
  if (!stat.isDirectory()) return { agent: null, env: null, errors: [`${dir}: not a directory`] };

  // Compare exact names: macOS file systems would otherwise open AGENT.md as agent.md.
  const names = readdirSync(dir);
  const errors = [];
  const read = (name) => {
    try {
      if (!names.includes(name)) {
        const wrongCase = names.find((n) => n.toLowerCase() === name);
        const hint = wrongCase ? ` (found ${wrongCase}; the name must be lowercase)` : "";
        throw new FileError(`${name}: missing${hint}`);
      }
      return parseMarkdown(readFileSync(join(dir, name), "utf8"), name);
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
      return null;
    }
  };

  return { agent: read(AGENT_FILE), env: read(ENV_FILE), errors };
}

// The bodies sent to POST /v1/agents and POST /v1/environments.
// The agent's tools come from tools/, compiled into the API's `tools` list.
export function agentBody({ agent, tools }) {
  const body = { ...agent.data, tools: compileTools(tools) };
  if (agent.body) body.system = agent.body;
  return body;
}

export function envBody({ env }) {
  return { ...env.data };
}
