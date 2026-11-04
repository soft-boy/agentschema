#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { chat } from "../src/chat.js";
import { spawn } from "node:child_process";
import { credCreate, credDeploy } from "../src/cred-menu.js";
import { credDelete, credLogin } from "../src/cred.js";
import { check } from "../src/check.js";
import { DeleteError, deleteAgent, deleteSession } from "../src/delete.js";
import { DeployError, deploy } from "../src/deploy.js";
import { loadEnvFile } from "../src/dotenv.js";
import { InitError, init } from "../src/init.js";
import { listAgents, listSessions } from "../src/list.js";
import { prompts } from "../src/prompts.js";
import { SessionError, openSession } from "../src/session.js";
import { toolsCreate } from "../src/tools-menu.js";

const FOOTER = `ags is a short name for agentschema. dir defaults to the current directory. Every command
but init, check and tools create authenticates with ANTHROPIC_API_KEY, or with a profile from \`ant auth login\`.`;

const USAGE = `Usage: agentschema <command> [dir] [options]

Commands:
  init <name>           Scaffold a new agent folder, asking a few questions
  check [dir]           Validate the folder's files, without calling the API
  deploy [dir]          Create or update the agent, environment and vaults, and write claude-lock.json
  run [dir]             Chat with the deployed agent in a new session, loading dir/.env for your tools
  list                  List the agents in your workspace
  delete <agent_id>     Archive an agent (agents can't be deleted outright)
  tools <command>       Add pre-built tools, custom tools and MCP servers (agentschema tools -h)
  sessions <command>    List and delete sessions (agentschema sessions -h)
  cred <command>        Create and manage the credentials in vaults/ (agentschema cred -h)

Options:
  -y, --yes         (init) Skip the questions and use the defaults
                    (delete) Don't ask for confirmation
  --dry-run         (deploy) Show what would be created or updated, change nothing
  --force           (deploy) Update the agent even if it was changed outside this folder
  --resume <id>     (run) Resume an existing session (sesn_...) instead of starting one
  -h, --help        Show this help
  -v, --version     Show the version

${FOOTER}`;

const TOOLS_USAGE = `Usage: agentschema tools <command> [options]

Each tool is a file in tools/. The pre-built tools share one file, each custom tool has its own,
and so does each MCP server.

Commands:
  create [dir]    Add a tool: asks whether it's the pre-built tools, a custom tool or an
                  MCP server, then writes its file

Options:
  -h, --help      Show this help

dir defaults to the current directory.`;

const SESSIONS_USAGE = `Usage: agentschema sessions <command> [options]

Commands:
  list            List the sessions in your workspace, newest first
  delete <id>     Delete a session and its history

Options:
  -y, --yes       (delete) Don't ask for confirmation
  -h, --help      Show this help

Resume a session with agentschema run --resume <id>.`;

const CRED_USAGE = `Usage: agentschema cred <command> [options]

Each credential is a file in vaults/<vault>/<name>.md, without its secrets, which go straight
to Anthropic.

Commands:
  create [dir]    Add a credential: asks which vault it goes in and whether it's for an MCP
                  server or an environment variable, writes its file, then signs you in or
                  asks for its secrets, and creates it in Anthropic
  deploy <file>   Create the credential a file describes in Anthropic, by signing in or
                  pasting its secrets
  login <file>    Sign in to the credential's MCP server in the browser, and store the tokens,
                  creating the credential or replacing the tokens of the existing one
  delete <file>   Delete the credential a file describes from Anthropic; the file stays

Options:
  --port <port>   (create, deploy, login) Port for the sign-in redirect (default: any free port)
  -y, --yes       (delete) Don't ask for confirmation
  -h, --help      Show this help

dir defaults to the current directory.`;

// The commands that group subcommands, and their help.
const GROUPS = { tools: TOOLS_USAGE, sessions: SESSIONS_USAGE, cred: CRED_USAGE };

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  resume: { type: "string" },
  port: { type: "string" },
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
  "tools create": { args: [0, 1], options: [] },
  "sessions list": { args: [0, 0], options: [] },
  "sessions delete": { args: [1, 1], options: ["yes"] },
  "cred create": { args: [0, 1], options: ["port"] },
  "cred deploy": { args: [1, 1], options: ["port"] },
  "cred login": { args: [1, 1], options: ["port"] },
  "cred delete": { args: [1, 1], options: ["yes"] },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    console.error(`agentschema: ${err.message}\n\n${GROUPS[argv[0]] ?? USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  let [command, ...args] = positionals;
  const group = command in GROUPS ? command : null;
  if (group) command = `${group} ${args.shift() ?? ""}`.trim();
  const usage = group ? GROUPS[group] : USAGE;

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (!command) {
    console.log(USAGE);
    return 1;
  }
  if (group && command === group) {
    console.error(usage);
    return 1;
  }
  if (!(command in COMMANDS)) {
    console.error(`agentschema: unknown command "${command}"\n\n${usage}`);
    return 1;
  }
  const spec = COMMANDS[command];
  const misplaced = Object.keys(values).filter((k) => !spec.options.includes(k));
  if (args.length > spec.args[1] || misplaced.length > 0) {
    const arg = args[spec.args[1]] ?? `--${misplaced[0]}`;
    console.error(`agentschema: unexpected argument ${arg} for ${command}\n\n${usage}`);
    return 1;
  }
  if (args.length < spec.args[0]) {
    const example = { init: "init my-agent", delete: "delete agent_…", "sessions delete": "sessions delete sesn_…", "cred deploy": "cred deploy my-agent/vaults/Ops/Slack.md", "cred login": "cred login my-agent/vaults/Ops/Slack.md", "cred delete": "cred delete my-agent/vaults/Ops/Slack.md" }[command];
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

    if (command === "tools create") {
      const io = prompts(process.stdin, process.stdout, { cancelled: () => new DeployError("cancelled") });
      try {
        await toolsCreate(args[0] ?? ".", { io, log: (line) => console.log(line) });
      } finally {
        io.close();
      }
      return 0;
    }

    if (["cred create", "cred deploy", "cred login"].includes(command)) {
      if (values.port !== undefined && !/^\d+$/.test(values.port)) throw new DeployError(`--port must be a number, not "${values.port}"`);
      const io = prompts(process.stdin, process.stdout, { cancelled: () => new DeployError("cancelled") });
      const options = { client: makeClient(false), openBrowser, port: values.port ?? 0, log: (line) => console.log(line) };
      try {
        if (command === "cred create") await credCreate(args[0] ?? ".", { ...options, io });
        else if (command === "cred deploy") await credDeploy(args[0], { ...options, io });
        else await credLogin(args[0], { ...options, ask: (q, { secret }) => (secret ? io.secret(q.trim()) : io.text(q.trim())) });
      } finally {
        io.close();
      }
      return 0;
    }

    if (command === "cred delete") {
      await credDelete(args[0], {
        client: makeClient(false),
        confirm: values.yes ? async () => true : confirm,
        log: (line) => console.log(line),
      });
      return 0;
    }

    if (command === "run") {
      // Made first, so .env only reaches your tools: Anthropic credentials still come from the
      // shell, the same as for every other command.
      const client = makeClient(false);
      for (const warning of loadEnvFile(dir)) console.warn(`warning: ${warning}`);
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

// Opens a URL in the default browser; the URL is also printed, in case this fails.
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The URL was printed; the user can open it.
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
