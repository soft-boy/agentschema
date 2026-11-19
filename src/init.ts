import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { AGENT_FILE, COMPUTER_FILE } from "../lib/instance.ts";
import { MODELS, NETWORKING, defaultAnswers, scaffold } from "../lib/scaffold.ts";
import type { Answers } from "../lib/scaffold.ts";
import { TOOLSET_FILE, TOOLS_DIR } from "../lib/tools.ts";
import { choosePermission } from "./tools-menu.ts";
import { prompts } from "./prompts.ts";
import type { PromptInput } from "./prompts.ts";

export class InitError extends Error {}

// The answers used when a question is skipped (--yes, or input ends early).
export const defaults = (dir: string): Answers => defaultAnswers(basename(resolve(dir)));

export interface InitOptions {
  // Skip the questions and use the defaults.
  yes?: boolean;
  input?: PromptInput;
  output?: NodeJS.WritableStream;
}

// Asks the setup questions, then writes agent.md and env.md into a new folder `dir`.
// Returns the files written, as { path: text }.
export async function init(dir: string, { yes = false, input = process.stdin, output = process.stdout }: InitOptions = {}): Promise<Record<string, string>> {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new InitError(`${dir} already exists and isn't empty`);
  }

  const answers = defaults(dir);
  if (!yes) await ask(answers, input, output);

  const files = scaffold(answers);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true });
    writeFileSync(resolve(dir, file), text);
  }

  const tools = answers.tools ? `, and ${dir}/${TOOLS_DIR}/${TOOLSET_FILE} with the computer tools (set Enabled to false to turn one off)` : "";
  output.write(`\nCreated ${dir}/${AGENT_FILE} and ${dir}/${COMPUTER_FILE}${tools}.\n\nNext:\n`);
  output.write(`  agentschema deploy ${dir}\n  agentschema run ${dir}\n`);
  return files;
}

// Fills in `answers` from the user's replies; an empty reply keeps the default shown.
async function ask(answers: Answers, input: PromptInput, output: NodeJS.WritableStream): Promise<void> {
  const io = prompts(input, output, { cancelled: () => new InitError("cancelled") });
  const { confirm } = io;

  try {
    answers.name = await io.text("Agent name?", answers.name);
    answers.model = await io.select("Model?", MODELS, answers.model);
    answers.system = await io.text("System prompt?", answers.system);
    answers.tools = await confirm("Give it the built-in tools (bash, files, web)?", answers.tools);
    if (answers.tools) answers.permission = await choosePermission(io, answers.permission);
    answers.environment = await io.text("Environment name?", answers.environment);
    answers.networking = await io.select("Networking?", NETWORKING, answers.networking);
    if (answers.networking === "limited") {
      answers.packageManagers = await confirm("Allow package managers (npm, pip, …)?", answers.packageManagers);
    }
  } finally {
    io.close();
  }
}
