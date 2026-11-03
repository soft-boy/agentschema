#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { chat } from "../src/chat.js";
import { check } from "../src/check.js";
import { DeleteError, deleteAgent, deleteSession } from "../src/delete.js";
import { DeployError, deploy } from "../src/deploy.js";
import { InitError, init } from "../src/init.js";
import { listAgents, listSessions } from "../src/list.js";
import { SessionError, openSession } from "../src/session.js";

const USAGE = `Usage: agentschema <command> [dir] [options]

Commands:
  init <name>           Scaffold a new agent folder, asking a few questions
  check [dir]           Validate agent.md and env.md, without calling the API
  deploy [dir]          Create or update the agent and environment, and write claude-lock.json
  run [dir]             Chat with the deployed agent in a new session
  list                  List the agents in your workspace
  delete <agent_id>     Archive an agent (agents can't be deleted outright)
  sessions list         List the sessions in your workspace, newest first
  sessions delete <id>  Delete a session and its history

Options:
  -y, --yes         (init) Skip the questions and use the defaults
                    (delete) Don't ask for confirmation
  --dry-run         (deploy) Show what would be created or updated, change nothing
  --force           (deploy) Update the agent even if it was changed outside this folder
  --resume <id>     (run) Resume an existing session (sesn_...) instead of starting one
  -h, --help        Show this help
  -v, --version     Show the version

dir defaults to the current directory. Every command but init and check authenticates with
ANTHROPIC_API_KEY, or with a profile from \`ant auth login\`.`;

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  resume: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};
// For each command: how many positional arguments it takes, and which options.
const COMMANDS = {
  init: { args: [1, 1], options: ["yes"] },
  check: { args: [0, 1], options: [] },
  deploy: { args: [0, 1], options: ["dry-run", "force"] },
  run: { args: [0, 1], options: ["resume"] },
  list: { args: [0, 0], options: [] },
  delete: { args: [1, 1], options: ["yes"] },
  "sessions list": { args: [0, 0], options: [] },
  "sessions delete": { args: [1, 1], options: ["yes"] },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    console.error(`agentschema: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  let [command, ...args] = positionals;
  if (command === "sessions") command = `sessions ${args.shift() ?? ""}`.trim();

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  if (!command || values.help) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }
  if (command.startsWith("sessions") && !(command in COMMANDS)) {
    console.error(`agentschema: usage: agentschema sessions list | sessions delete <id>`);
    return 1;
  }
  if (!(command in COMMANDS)) {
    console.error(`agentschema: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const spec = COMMANDS[command];
  const misplaced = Object.keys(values).filter((k) => !spec.options.includes(k));
  if (args.length > spec.args[1] || misplaced.length > 0) {
    const arg = args[spec.args[1]] ?? `--${misplaced[0]}`;
    console.error(`agentschema: unexpected argument ${arg} for ${command}\n\n${USAGE}`);
    return 1;
  }
  if (args.length < spec.args[0]) {
    const example = { init: "init my-agent", delete: "delete agent_…", "sessions delete": "sessions delete sesn_…" }[command];
    console.error(`agentschema: ${command} needs an argument, e.g. agentschema ${example}`);
    return 1;
  }
  const dir = args[0] ?? ".";

  if (command === "init") {
    try {
      await init(dir, { yes: values.yes ?? false });
      return 0;
    } catch (err) {
      if (!(err instanceof InitError)) throw err;
      console.error(`error: ${err.message}`);
      return 1;
    }
  }

  if (command === "check") {
    const { errors, warnings } = check(dir);
    for (const w of warnings) console.warn(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);
    if (errors.length > 0) return 1;
    console.log(`${dir}: ok`);
    return 0;
  }

  try {
    if (command === "deploy") {
      for (const w of check(dir).warnings) console.warn(`warning: ${w}`);
      const dryRun = values["dry-run"] ?? false;
      await deploy(dir, {
        client: makeClient(dryRun),
        dryRun,
        force: values.force ?? false,
        log: (line) => console.log(line),
      });
      return 0;
    }

    if (command === "list" || command === "sessions list") {
      const lines = command === "list" ? await listAgents(makeClient(false)) : await listSessions(makeClient(false));
      for (const line of lines) console.log(line);
      return 0;
    }

    if (command === "delete" || command === "sessions delete") {
      const remove = command === "delete" ? deleteAgent : deleteSession;
      await remove(makeClient(false), args[0], {
        confirm: values.yes ? async () => true : confirm,
        log: (line) => console.log(line),
      });
      return 0;
    }

    if (command === "run") {
      const client = makeClient(false);
      const { session, notes } = await openSession(dir, {
        client,
        sessionId: values.resume,
      });
      for (const note of notes) console.warn(`warning: ${note}`);
      await chat(client, session, { agentName: session.agent?.name ?? "agent", tools: customTools(dir) });
      return 0;
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`error: ${err.status ?? "network error"}: ${err.error?.error?.message ?? err.message}`);
      return 1;
    }
    if (err instanceof DeployError || err instanceof DeleteError || err instanceof SessionError || err instanceof Anthropic.AnthropicError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

// Asks a yes/no question in the terminal; without one, there's no one to ask.
async function confirm(question) {
  if (!process.stdin.isTTY) throw new DeleteError("not a terminal, so can't ask for confirmation; pass --yes");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

// The folder's custom tools, by name, for run to execute. A folder that doesn't pass check
// runs none of them; run asks you for each result instead.
function customTools(dir) {
  const { instance, errors } = check(dir);
  const customs = instance?.tools.filter((t) => t.data.type === "custom") ?? [];
  if (customs.length === 0) return {};
  if (errors.length > 0) {
    console.warn(`warning: ${dir} doesn't pass check, so its custom tools won't run; you'll be asked for each result`);
    return {};
  }
  return Object.fromEntries(customs.map((t) => [t.name, t]));
}

// A dry run makes no API calls, so it works without credentials.
function makeClient(dryRun) {
  try {
    return new Anthropic();
  } catch (err) {
    if (!dryRun) throw err;
    return { baseURL: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" };
  }
}

process.exitCode = await main(process.argv.slice(2));
