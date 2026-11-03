import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

export const AGENT_FILE = "agent.md";
export const ENV_FILE = "env.md";

export class FileError extends Error {}

// Splits a Markdown file into YAML frontmatter (between `---` fences) and body.
export function parseMarkdown(text, file) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new FileError(`${file}: must start with YAML frontmatter between --- lines`);
  }
  const closing = /^---[ \t]*$/m.exec(normalized.slice(4));
  if (!closing) throw new FileError(`${file}: frontmatter is not closed with a --- line`);
  const end = 4 + closing.index;
  const afterFence = normalized.slice(end + closing[0].length);

  const doc = parseDocument(normalized.slice(4, end));
  if (doc.errors.length > 0) {
    // The YAML library counts lines from the start of the frontmatter; +1 for the opening fence.
    const err = doc.errors[0];
    const line = err.linePos?.[0]?.line;
    const where = line ? `:${line + 1}` : "";
    throw new FileError(`${file}${where}: invalid YAML: ${err.message.split("\n")[0]}`);
  }

  const data = doc.toJS() ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FileError(`${file}: frontmatter must be a YAML mapping (key: value pairs)`);
  }
  return { data, body: afterFence.trim(), raw: text };
}

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
export function agentBody(agent) {
  const body = { ...agent.data };
  if (agent.body) body.system = agent.body;
  return body;
}

export function envBody(env) {
  return { ...env.data };
}
