import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { AGENT_FILE, ENV_FILE } from "./instance.js";
import { prompts } from "./prompts.js";
import { TOOLSET_FILE, PREBUILT_TOOLS, TOOLSET, TOOLS_DIR } from "./tools.js";

export class InitError extends Error {}

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const NETWORKING = ["limited", "unrestricted"];

// The answers used when a question is skipped (--yes, or input ends early).
export function defaults(dir) {
  const slug = basename(resolve(dir)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  return {
    name: slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    model: MODELS[0],
    system: "You are a helpful assistant.",
    tools: true,
    environment: slug,
    networking: "limited",
    packageManagers: true,
  };
}

// Returns { path: text } for a set of answers: agent.md, env.md, and tools/agent_toolset_20260401.md
// listing every pre-built tool when the agent gets them.
export function scaffold(answers) {
  const agent = { name: answers.name, model: answers.model };

  const networking = { type: answers.networking };
  if (answers.networking === "limited") networking.allow_package_managers = answers.packageManagers;
  const env = { name: answers.environment, config: { type: "cloud", networking } };

  const access = answers.networking === "unrestricted"
    ? "unrestricted network access"
    : answers.packageManagers ? "limited networking and package manager access" : "limited networking";
  const files = {
    [AGENT_FILE]: `---\n${stringify(agent)}---\n\n${answers.system.trim()}\n`,
    [ENV_FILE]: `---\n${stringify(env)}---\nCloud container with ${access}.\n`,
  };
  if (answers.tools) {
    files[`${TOOLS_DIR}/${TOOLSET_FILE}`] = builtInFile(PREBUILT_TOOLS);
  }
  return files;
}

// The pre-built toolset file, with a row for each of `names`: on if it's in `enabled`, with the
// API's default permission policy.
export function builtInFile(names, enabled = names) {
  const rows = names.map((name) => `| \`${name}\` | \`${enabled.includes(name)}\` | |`).join("\n");
  return `---\ntype: ${TOOLSET}\n---\n\nThe tools Claude runs in the agent's container. Set Enabled to false to turn a tool off.\n\n## Tools\n\n| Name | Enabled | Permission |\n|---|---|---|\n${rows}\n`;
}

// Asks the setup questions, then writes agent.md and env.md into a new folder `dir`.
export async function init(dir, { yes = false, input = process.stdin, output = process.stdout } = {}) {
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

  const tools = answers.tools ? `, and ${dir}/${TOOLS_DIR}/${TOOLSET_FILE} with the pre-built tools (set Enabled to false to turn one off)` : "";
  output.write(`\nCreated ${dir}/${AGENT_FILE} and ${dir}/${ENV_FILE}${tools}.\n\nNext:\n`);
  output.write(`  agentschema deploy ${dir}\n  agentschema run ${dir}\n`);
  return files;
}

// Fills in `answers` from the user's replies; an empty reply keeps the default shown.
async function ask(answers, input, output) {
  const io = prompts(input, output, { cancelled: () => new InitError("cancelled") });
  const { confirm } = io;

  try {
    answers.name = await io.text("Agent name?", answers.name);
    answers.model = await io.select("Model?", MODELS, answers.model);
    answers.system = await io.text("System prompt?", answers.system);
    answers.tools = await confirm("Give it the built-in tools (bash, files, web)?", answers.tools);
    answers.environment = await io.text("Environment name?", answers.environment);
    answers.networking = await io.select("Networking?", NETWORKING, answers.networking);
    if (answers.networking === "limited") {
      answers.packageManagers = await confirm("Allow package managers (npm, pip, …)?", answers.packageManagers);
    }
  } finally {
    io.close();
  }
}
