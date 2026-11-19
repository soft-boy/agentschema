import { stringify } from "yaml";
import { AGENT_FILE, COMPUTER_FILE } from "./instance.ts";
import { COMPUTER_TOOLS, TOOLSET, TOOLSET_FILE, TOOLS_DIR } from "./tools.ts";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const NETWORKING = ["limited", "unrestricted"];

// The answers to init's questions.
export interface Answers {
  name: string;
  model: string;
  system: string;
  tools: boolean;
  permission: string;
  environment: string;
  networking: string;
  packageManagers: boolean;
}

// The answers used for a new agent called `name`, when a question is skipped.
export function defaultAnswers(name: string): Answers {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  return {
    name: slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    model: MODELS[0],
    system: "You are a helpful assistant.",
    tools: true,
    permission: "auto",
    environment: slug,
    networking: "limited",
    packageManagers: true,
  };
}

// Returns { path: text } for a set of answers: agent.md, env.md, and tools/agent_toolset_20260401.md
// listing every computer tool when the agent gets them.
export function scaffold(answers: Answers): Record<string, string> {
  const agent = { name: answers.name, model: answers.model };

  const networking: { type: string; allow_package_managers?: boolean } = { type: answers.networking };
  if (answers.networking === "limited") networking.allow_package_managers = answers.packageManagers;
  const env = { name: answers.environment, config: { type: "cloud", networking } };

  const access = answers.networking === "unrestricted"
    ? "unrestricted network access"
    : answers.packageManagers ? "limited networking and package manager access" : "limited networking";
  const files: Record<string, string> = {
    [AGENT_FILE]: `---\n${stringify(agent)}---\n\n${answers.system.trim()}\n`,
    [COMPUTER_FILE]: `---\n${stringify(env)}---\nCloud container with ${access}.\n`,
  };
  if (answers.tools) {
    files[`${TOOLS_DIR}/${TOOLSET_FILE}`] = builtInFile(COMPUTER_TOOLS, COMPUTER_TOOLS, answers.permission);
  }
  return files;
}

// The computer toolset file, with a row for each of `names`: on if it's in `enabled`, each with
// `permission`, so what's chosen is there to read and change. `auto` is what the API recommends for
// these tools: Anthropic judges each call, and asks when it can't tell.
export function builtInFile(names: string[], enabled: string[] = names, permission = "auto"): string {
  const rows = names.map((name) => `| \`${name}\` | \`${enabled.includes(name)}\` | \`${permission}\` |`).join("\n");
  return `---\ntype: ${TOOLSET}\n---\n\nThe tools Claude runs in the agent's container. Set Enabled to false to turn a tool off.\n\n## Tools\n\n| Name | Enabled | Permission |\n|---|---|---|\n${rows}\n`;
}
