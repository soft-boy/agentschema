import { textOf } from "./files.js";
import { FileError, parseMarkdown } from "./markdown.js";
import { systemPromptOf } from "./system-prompt.js";
import { compileTools } from "./tools.js";

export const AGENT_FILE = "agent.md";
export const ENV_FILE = "env.md";

// Reads agent.md and env.md. Returns { agent, env, errors }; a file that can't be read is null
// and has an entry in errors.
export function readInstance(files) {
  const names = Object.keys(files).filter((path) => !path.includes("/"));
  const errors = [];
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
  return { agent: read(AGENT_FILE), env: read(ENV_FILE), errors };
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
