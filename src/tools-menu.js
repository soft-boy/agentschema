import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { check } from "./check.js";
import { serviceName } from "./cred-menu.js";
import { DeployError } from "./deploy.js";
import { AGENT_FILE, ENV_FILE } from "../lib/instance.js";
import { builtInFile } from "../lib/scaffold.js";
import { updateFrontmatter } from "./folder.js";
import { listMcpTools } from "./mcp.js";
import { MCP_TOOLSET, POLICIES, PREBUILT_TOOLS, TOOLSET, TOOLSET_FILE, TOOLS_DIR, mcpToolsetFile } from "../lib/tools.js";

const PREBUILT = "Pre-built tools (bash, files, web search)";
const CUSTOM = "Custom tool (JavaScript that runs on your machine)";
const MCP = "MCP server";
const INPUT_TYPES = ["string", "number", "integer", "boolean", "object", "string[]", "number[]", "integer[]", "boolean[]", "object[]"];

// `tools create`: asks what kind of tool to add, then writes its file in tools/.
// Returns the path of the file written.
export async function toolsCreate(dir = ".", { io, fetch = globalThis.fetch, log = () => {} }) {
  const { errors, instance } = check(dir);
  if (!instance) throw new DeployError(`${dir} isn't an agent folder:\n  ${errors.join("\n  ")}`);

  const kind = await io.select("What kind of tool?", [PREBUILT, CUSTOM, MCP], PREBUILT);
  const write = kind === PREBUILT ? prebuilt : kind === CUSTOM ? custom : mcp;
  const { path, text, addServer } = await write(dir, instance, io, { fetch, log });

  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  log(`Wrote ${file}`);
  if (addServer) {
    updateFrontmatter(join(dir, AGENT_FILE), (doc) => {
      if (doc.hasIn(["mcp_servers"])) doc.addIn(["mcp_servers"], doc.createNode(addServer));
      else doc.setIn(["mcp_servers"], doc.createNode([addServer]));
    });
    log(`Added ${addServer.name} to mcp_servers in ${join(dir, AGENT_FILE)}`);
  }

  const after = check(dir);
  const related = (m) => m.startsWith(path) || (kind === MCP && (m.startsWith(AGENT_FILE) || m.startsWith(ENV_FILE)));
  for (const w of after.warnings.filter(related)) log(`warning: ${w}`);
  for (const e of after.errors.filter(related)) log(`error: ${e}`);
  if (kind === CUSTOM) log(`\nWrite the tool's code in its ## Code block, then deploy with:\n  agentschema deploy ${dir}`);
  else if (kind === MCP) log(`\nIf the server needs you to sign in, add a credential for it:\n  agentschema cred create ${dir}\nThen deploy with:\n  agentschema deploy ${dir}`);
  else log(`\nDeploy with:\n  agentschema deploy ${dir}`);
  return file;
}

// The pre-built toolset: one file, with a row for each tool.
async function prebuilt(dir, { tools }, io) {
  const existing = tools.find((t) => t.data.type === TOOLSET);
  if (existing) throw new DeployError(`the agent already has its pre-built tools in ${existing.file}; edit that file's table to turn tools on or off`);

  let enabled = PREBUILT_TOOLS;
  if (!(await io.confirm(`Turn on all eight (${PREBUILT_TOOLS.join(", ")})?`, true))) {
    enabled = [];
    for (const name of PREBUILT_TOOLS) if (await io.confirm(`  ${name}?`, true)) enabled.push(name);
  }
  return { path: `${TOOLS_DIR}/${TOOLSET_FILE}`, text: builtInFile(PREBUILT_TOOLS, enabled, await choosePermission(io, "auto")) };
}

// A custom tool: its name, description and inputs, with a code block to fill in.
async function custom(dir, { tools }, io) {
  const taken = new Set(tools.filter((t) => t.data.type === "custom").map((t) => t.name));
  const name = await io.text("Tool name? (letters, digits, _ and -)", "", {
    validate: (n) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n)) return "Use letters, digits, _ and -, up to 64 characters";
      if (PREBUILT_TOOLS.includes(n)) return `${n} is a pre-built tool's name`;
      if (/^(mcp__|ant__)/.test(n)) return "A custom tool's name can't start with mcp__ or ant__";
      if (taken.has(n) || existsSync(join(dir, TOOLS_DIR, `${n}.md`))) return `There's already a tool called ${n}`;
      return null;
    },
  });
  const description = await io.text("What does it do? (Claude reads this to decide when to call it)", "", {
    validate: (d) => (d ? null : "The description is required"),
  });

  const inputs = [];
  while (true) {
    const input = await io.text(inputs.length === 0 ? "First input's name? (Enter for none)" : "Next input's name? (Enter when done)", "", {
      validate: (n) => {
        if (n && !/^[a-zA-Z_$][\w$]*$/.test(n)) return "Use a name like city or max_results";
        if (inputs.some((i) => i.name === n)) return `${n} is already an input`;
        return null;
      },
    });
    if (!input) break;
    const type = await io.select(`  ${input}'s type?`, INPUT_TYPES, "string");
    const about = await io.text(`  ${input}'s description?`, "");
    const required = await io.confirm(`  Is ${input} required?`, true);
    inputs.push({ name: input, type, about, required });
  }

  const cell = (s) => s.replace(/\|/g, "\\|");
  const table = inputs.length === 0 ? "" : [
    "## Input Schema", "",
    "| Name | Type | Description | Required |",
    "|---|---|---|---|",
    ...inputs.map((i) => `| \`${i.name}\` | \`${i.type}\` | ${cell(i.about)} | \`${i.required}\` |`),
    "", "",
  ].join("\n");
  const args = inputs.length === 0 ? "()" : `({ ${inputs.map((i) => i.name).join(", ")} })`;
  const code = [
    "## Code", "",
    "```javascript",
    `module.exports = async ${args} => {`,
    `  throw new Error("${name} isn't implemented yet");`,
    "};",
    "```", "",
  ].join("\n");

  const front = stringify({ type: "custom", name, description });
  return { path: `${TOOLS_DIR}/${name}.md`, text: `---\n${front}---\n\n${table}${code}` };
}

// An MCP server: its URL and name, how its tools are approved, and a table of those tools.
// The server itself is declared in agent.md; a server already declared there only needs its file.
async function mcp(dir, instance, io, { fetch, log }) {
  const { tools, agent } = instance;
  const declared = Array.isArray(agent.data.mcp_servers) ? agent.data.mcp_servers : [];
  const toolsets = new Set(tools.filter((t) => t.data.type === MCP_TOOLSET).map((t) => t.data.mcp_server_name));
  const url = await io.text("MCP server URL?", "", {
    validate: (u) => {
      if (!/^https?:\/\/\S+$/.test(u)) return "Enter an http(s) URL";
      const same = declared.find((s) => s?.url === u);
      return same && toolsets.has(same.name) ? `${AGENT_FILE} already declares that server, as ${same.name}` : null;
    },
  });
  const existing = declared.find((s) => s?.url === url);
  const name = existing?.name ?? await io.text("Name for it?", serviceName(url).toLowerCase(), {
    validate: (n) => {
      if (!n || /[/\\]/.test(n) || n.startsWith(".")) return "Use a name without / that doesn't start with .";
      if (declared.some((s) => s?.name === n)) return `${AGENT_FILE} already declares a server called ${n}`;
      if (existsSync(join(dir, TOOLS_DIR, `${n}.md`))) return `There's already a tool file called ${n}.md`;
      return null;
    },
  });
  const addServer = existing ? null : { type: "url", name, url };

  const permission = await choosePermission(io, "always_ask");

  log(`Asking ${url} for its tools…`);
  const names = await listMcpTools(url, { fetch });
  if (names) log(`It has ${names.length} tool${names.length === 1 ? "" : "s"}.`);
  else log("It won't list its tools without signing in, so they'll be listed once you have; until then, every tool is on.");
  return { path: `${TOOLS_DIR}/${name}.md`, text: mcpToolsetFile({ name, tools: names ?? [], permission }), addServer };
}

// Asks how a set of tools should be approved, offering `recommended` first.
export async function choosePermission(io, recommended) {
  const policies = [recommended, ...POLICIES.filter((p) => p !== recommended)];
  const answer = await io.select("Ask you before each call? (permission for its tools)", policies.map(describePolicy), describePolicy(recommended));
  return policies.find((p) => describePolicy(p) === answer);
}

function describePolicy(policy) {
  return {
    always_ask: "always_ask: ask before every call (the API's default for MCP tools)",
    always_allow: "always_allow: never ask",
    auto: "auto: Anthropic decides per call, and asks when it can't",
  }[policy];
}
