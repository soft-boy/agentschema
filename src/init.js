import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { stringify } from "yaml";
import { AGENT_FILE, ENV_FILE } from "./instance.js";
import { BUILT_IN_DIR, PREBUILT_TOOLS, TOOLSET, TOOLS_DIR } from "./tools.js";

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

// Returns { path: text } for a set of answers: agent.md, env.md, and a tools/built-in/ file
// for each pre-built tool when the agent gets them.
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
    for (const name of PREBUILT_TOOLS) files[`${TOOLS_DIR}/${BUILT_IN_DIR}/${name}.md`] = `---\ntype: ${TOOLSET}\n---\n`;
  }
  return files;
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

  const tools = answers.tools ? `, and ${dir}/${TOOLS_DIR}/${BUILT_IN_DIR}/ with the pre-built tools (delete a file to disable that tool)` : "";
  output.write(`\nCreated ${dir}/${AGENT_FILE} and ${dir}/${ENV_FILE}${tools}.\n\nNext:\n`);
  output.write(`  agentschema deploy ${dir}\n  agentschema run ${dir}\n`);
  return files;
}

// Fills in `answers` from the user's replies; an empty reply keeps the default shown.
async function ask(answers, input, output) {
  const io = input.isTTY ? terminalPrompts(input, output) : linePrompts(input, output);
  const confirm = async (question, fallback) => {
    while (true) {
      const reply = (await io.text(`${question} [y/n]`, fallback ? "y" : "n")).toLowerCase();
      if (/^(y|yes)$/.test(reply)) return true;
      if (/^(n|no)$/.test(reply)) return false;
      output.write("Answer y or n\n");
    }
  };

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

// Prompts for piped input: one answer per line, and choices picked by name or number.
function linePrompts(input, output) {
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let ended = false;

  const text = async (question, fallback) => {
    if (ended) return fallback;
    output.write(`${question} (${fallback}) `);
    const { value, done } = await lines.next();
    if (done) {
      ended = true;
      output.write("\n");
      return fallback;
    }
    return value.trim() || fallback;
  };
  const select = async (question, choices, fallback) => {
    const listed = choices.map((c, i) => `${i + 1}) ${c}`).join("  ");
    while (true) {
      const reply = await text(`${question} ${listed}`, String(choices.indexOf(fallback) + 1));
      const picked = choices[Number(reply) - 1] ?? choices.find((c) => c === reply);
      if (picked) return picked;
      output.write(`Pick one of: ${choices.join(", ")}\n`);
    }
  };
  return { text, select, close: () => rl.close() };
}

const ESC = "\x1b[";
const cyan = (s) => `${ESC}36m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;

// Prompts for a terminal: choices are picked with the arrow keys and Enter.
function terminalPrompts(input, output) {
  const cancelled = () => new InitError("cancelled");

  // A fresh readline per question, so it doesn't fight the raw-mode select for the arrow keys.
  const text = (question, fallback) =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true });
      rl.on("SIGINT", () => {
        rl.close();
        output.write("\n");
        reject(cancelled());
      });
      rl.question(`${question} ${dim(`(${fallback})`)} `, (reply) => {
        rl.close();
        resolve(reply.trim() || fallback);
      });
    });

  const select = (question, choices, fallback) =>
    new Promise((resolve, reject) => {
      let index = Math.max(0, choices.indexOf(fallback));
      const render = (first) => {
        if (!first) output.write(`${ESC}${choices.length}A`);
        for (const [i, choice] of choices.entries()) {
          output.write(`${ESC}2K${i === index ? cyan(`❯ ${choice}`) : `  ${choice}`}\n`);
        }
      };
      const finish = (err) => {
        input.off("keypress", onKey);
        input.setRawMode(false);
        input.pause();
        // Collapse the list to one line with the answer.
        output.write(`${ESC}${choices.length + 1}A${ESC}J${ESC}?25h`);
        output.write(`${question} ${err ? dim("cancelled") : cyan(choices[index])}\n`);
        err ? reject(err) : resolve(choices[index]);
      };
      const onKey = (str, key = {}) => {
        if (key.ctrl && key.name === "c") return finish(cancelled());
        if (key.name === "return" || key.name === "enter") return finish();
        if (key.name === "up" || key.name === "k") index = (index - 1 + choices.length) % choices.length;
        else if (key.name === "down" || key.name === "j" || key.name === "tab") index = (index + 1) % choices.length;
        else if (/^[1-9]$/.test(str ?? "") && Number(str) <= choices.length) index = Number(str) - 1;
        else return;
        render(false);
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write(`${question} ${dim("(↑/↓, Enter)")}\n${ESC}?25l`);
      render(true);
      input.on("keypress", onKey);
    });

  return { text, select, close() {} };
}
