#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { chat } from "../src/chat.js";
import { check } from "../src/check.js";
import { DeployError, deploy } from "../src/deploy.js";
import { SessionError, openSession } from "../src/session.js";

const USAGE = `Usage: agentschema <command> [dir] [options]

Commands:
  check [dir]     Validate agent.md and env.md, without calling the API
  deploy [dir]    Create or update the agent and environment, and write claude-lock.json
  run [dir]       Chat with the deployed agent in a new session

Options:
  --dry-run         (deploy) Show what would be created or updated, change nothing
  --force           (deploy) Update the agent even if it was changed outside this folder
  --vault <id>      (run) Attach a vault (vlt_...) for MCP and other credentials; repeatable
  --title <title>   (run) Title for the new session
  --session <id>    (run) Resume an existing session (sesn_...) instead of starting one
  -h, --help        Show this help
  -v, --version     Show the version

dir defaults to the current directory. deploy and run authenticate with
ANTHROPIC_API_KEY, or with a profile from \`ant auth login\`.`;

const OPTIONS = {
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  vault: { type: "string", multiple: true },
  title: { type: "string" },
  session: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};
const COMMAND_OPTIONS = {
  check: [],
  deploy: ["dry-run", "force"],
  run: ["vault", "title", "session"],
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
  const [command, dir = ".", ...extra] = positionals;

  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  if (!command || values.help) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }
  if (!(command in COMMAND_OPTIONS)) {
    console.error(`agentschema: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  const misplaced = Object.keys(values).filter((k) => !COMMAND_OPTIONS[command].includes(k));
  if (extra.length > 0 || misplaced.length > 0) {
    const arg = extra[0] ?? `--${misplaced[0]}`;
    console.error(`agentschema: unexpected argument ${arg} for ${command}\n\n${USAGE}`);
    return 1;
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

    if (command === "run") {
      const client = makeClient(false);
      const { session, notes } = await openSession(dir, {
        client,
        sessionId: values.session,
        vaultIds: values.vault ?? [],
        title: values.title,
      });
      for (const note of notes) console.warn(`warning: ${note}`);
      await chat(client, session, { agentName: session.agent?.name ?? "agent" });
      return 0;
    }
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`error: ${err.status ?? "network error"}: ${err.error?.error?.message ?? err.message}`);
      return 1;
    }
    if (err instanceof DeployError || err instanceof SessionError || err instanceof Anthropic.AnthropicError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
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
