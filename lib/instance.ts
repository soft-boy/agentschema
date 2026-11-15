import type { Channel } from "./channels.ts";
import { type FileMap, textOf } from "./files.ts";
import { FileError, type Frontmatter, type MarkdownFile, parseMarkdown } from "./markdown.ts";
import type { ScheduledTask } from "./scheduled.ts";
import type { Skill } from "./skills.ts";
import { type SystemPromptPart, systemPromptOf } from "./system-prompt.ts";
import { type CompileOptions, type Tool, compileTools } from "./tools.ts";
import type { Vault } from "./vaults.ts";

// computer.md, with the name it was read from (computer.md, or its old name env.md).
export interface EnvFile extends MarkdownFile {
  file: string;
}

// Everything in an agent's folder, read and checked: what checkFiles returns as `instance`.
export interface Instance {
  agent: MarkdownFile;
  env: EnvFile;
  tools: Tool[];
  vaults: Vault[];
  skills: Skill[];
  channels: Channel[];
  scheduled: ScheduledTask[];
  systemPrompt: SystemPromptPart[];
}

// The lock file, claude-lock.json: what each of the folder's files was deployed as, by key
// ("./agent.md", "./skills/x", …).
export interface Lock {
  resources?: Record<string, LockEntry>;
  [key: string]: unknown;
}

export type LockEntry = Record<string, any>;

export interface ReadInstanceResult {
  agent: MarkdownFile | null;
  env: EnvFile | null;
  errors: string[];
  warnings: string[];
}

export const AGENT_FILE = "agent.md";
export const COMPUTER_FILE = "computer.md";
// computer.md's old name. A folder that still has it works, with a warning to rename it.
export const OLD_COMPUTER_FILE = "env.md";

// Reads agent.md and computer.md. Returns { agent, env, errors, warnings }; a file that can't be
// read is null and has an entry in errors. `env` is computer.md, the agent's environment, and its
// `file` says which name it was read from.
export function readInstance(files: FileMap): ReadInstanceResult {
  const names = Object.keys(files).filter((path) => !path.includes("/"));
  const errors: string[] = [];
  const warnings: string[] = [];
  const read = (name: string): MarkdownFile | null => {
    try {
      // Exact names only, so an agent behaves the same on a case-sensitive file system.
      if (!names.includes(name)) {
        const wrongCase = names.find((n) => n.toLowerCase() === name);
        const hint = wrongCase ? ` (found ${wrongCase}; the name must be lowercase)` : "";
        throw new FileError(`${name}: missing${hint}`);
      }
      return parseMarkdown(textOf(files[name]!), name);
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
export function agentBody(
  instance: Pick<Instance, "agent" | "tools"> & Partial<Pick<Instance, "systemPrompt">>,
  skills: Frontmatter[] = [],
  options: CompileOptions = {},
): Frontmatter {
  const { agent, tools } = instance;
  const body: Frontmatter = { ...agent.data, tools: compileTools(tools, options) };
  if (skills.length > 0) body.skills = [...(agent.data.skills ?? []), ...skills];
  const system = systemPromptOf(instance);
  if (system) body.system = system;
  return body;
}

export function envBody({ env }: Pick<Instance, "env">): Frontmatter {
  return { ...env.data };
}

// The lock's entry for the environment is under "./computer.md". A lock written before computer.md
// was renamed has it under "./env.md": environmentEntry finds it either way, and upgradeLock moves
// it, so the next deploy updates that environment rather than making another.
export const ENVIRONMENT_KEY = `./${COMPUTER_FILE}`;
const OLD_ENVIRONMENT_KEY = `./${OLD_COMPUTER_FILE}`;

export const environmentEntry = (lock: Lock | null | undefined): LockEntry | undefined => lock?.resources?.[ENVIRONMENT_KEY] ?? lock?.resources?.[OLD_ENVIRONMENT_KEY];

export function upgradeLock<T extends Lock | null | undefined>(lock: T): T {
  const resources = lock?.resources;
  if (resources?.[OLD_ENVIRONMENT_KEY] && !resources[ENVIRONMENT_KEY]) {
    resources[ENVIRONMENT_KEY] = resources[OLD_ENVIRONMENT_KEY];
    delete resources[OLD_ENVIRONMENT_KEY];
  }
  return lock;
}
