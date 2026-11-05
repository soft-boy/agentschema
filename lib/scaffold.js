import { stringify } from "yaml";
import { AGENT_FILE, ENV_FILE } from "./instance.js";
import { PREBUILT_TOOLS, TOOLSET, TOOLSET_FILE, TOOLS_DIR } from "./tools.js";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const NETWORKING = ["limited", "unrestricted"];

// The answers used for a new agent called `name`, when a question is skipped.
export function defaultAnswers(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
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
