import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { Script, runInThisContext } from "node:vm";
import { FileError, parseMarkdown } from "./markdown.js";

export const TOOLS_DIR = "tools";
export const TOOLSET = "agent_toolset_20260401";
export const TOOLSET_FILE = `${TOOLSET}.md`;
export const MCP_TOOLSET = "mcp_toolset";
export const PREBUILT_TOOLS = ["bash", "edit", "glob", "grep", "read", "web_fetch", "web_search", "write"];
export const POLICIES = ["always_allow", "always_ask", "auto"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array"];

// Reads every .md file under tools/, in any subfolder, sorted by name. Folders are only for
// organizing: a custom tool's name is its file name, and its path isn't compiled into anything.
// The pre-built toolset is one file (by convention tools/agent_toolset_20260401.md) that lists its tools.
// A missing tools/ folder means no tools.
// Returns { tools, errors }; a tool file that can't be parsed has an entry in errors.
export function readTools(dir) {
  const folder = join(dir, TOOLS_DIR);
  try {
    if (!statSync(folder).isDirectory()) return { tools: [], errors: [`${TOOLS_DIR}: not a directory`] };
  } catch {
    return { tools: [], errors: [] };
  }

  const tools = [];
  const errors = [];
  for (const file of markdownFiles(folder, TOOLS_DIR)) {
    try {
      const parsed = parseMarkdown(readFileSync(join(dir, file), "utf8"), file);
      const name = basename(file, ".md");
      tools.push({ file, path: resolve(dir, file), name, ...parsed, ...parseSections(parsed.body, file) });
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
    }
  }

  // Custom tool names must be unique across folders, since the folders are dropped.
  for (const [type, what] of [["custom", "tool"], [MCP_TOOLSET, "MCP server"]]) {
    for (const [name, same] of groupBy(tools.filter((t) => t.data.type === type), (t) => t.name)) {
      if (same.length > 1) errors.push(`${TOOLS_DIR}: more than one ${what} is named \`${name}\` (${same.map((t) => t.file).join(", ")})`);
    }
  }
  const toolsets = tools.filter((t) => t.data.type === TOOLSET);
  if (toolsets.length > 1) {
    errors.push(`${TOOLS_DIR}: more than one \`${TOOLSET}\` file (${toolsets.map((t) => t.file).join(", ")}); list every pre-built tool in one file`);
  }
  return { tools: tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), errors };
}

// Paths, relative to the instance folder, of the .md files under `folder`; hidden entries are skipped.
function markdownFiles(folder, relative) {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...markdownFiles(join(folder, entry.name), rel));
    else if (entry.name.endsWith(".md")) files.push(rel);
  }
  return files;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

// Pulls the `## Input Schema` table, the `## Code` block and the `## Tools` table (for the
// pre-built toolset) out of a tool file's body.
function parseSections(body, file) {
  const sections = {};
  let current = null;
  let fence = null;
  for (const line of body.split("\n")) {
    const marker = /^(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || fence === marker)) fence = fence ? null : marker;
    const heading = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1].toLowerCase();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }

  const result = { params: null, code: null, rows: null };
  if (sections["input schema"]) {
    result.params = parseTable(sections["input schema"], `${file}: the Input Schema table's columns must be Name | Type | Description | Required`,
      ["name", "type", "description", "required"]);
  }
  if (sections.code) result.code = parseCode(sections.code, file);
  if (sections.tools) {
    result.rows = parseTable(sections.tools, `${file}: the Tools table's columns must be Name | Enabled, or Name | Enabled | Permission`, ["name", "enabled"], ["permission"]);
  }
  return result;
}

// The rows of a Markdown table as objects keyed by column name. The header must start with
// the `required` columns, and may go on with the `optional` ones, in order.
function parseTable(lines, message, required, optional = []) {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map(splitRow);
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.toLowerCase());
  const allowed = [...required, ...optional];
  if (header.length < required.length || header.length > allowed.length || header.some((c, i) => c !== allowed[i])) {
    throw new FileError(message);
  }
  return rows.slice(2).map((cells) => Object.fromEntries(header.map((c, i) => [c, cells[i] ?? ""])));
}

function splitRow(line) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|").replace(/^`(.*)`$/, "$1"));
}

function parseCode(lines, file) {
  const text = lines.join("\n");
  const blocks = [...text.matchAll(/^(```|~~~)[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)];
  if (blocks.length !== 1) throw new FileError(`${file}: the Code section must hold exactly one fenced code block`);
  const [, , lang, source] = blocks[0];
  return { lang: lang.toLowerCase(), source };
}

// Errors and warnings for the tool files, in check's format.
export function checkTools(tools, errors) {
  const customs = tools.filter((t) => t.data.type === "custom");
  if (customs.length + (customs.length < tools.length ? 1 : 0) > 256) errors.push(`${TOOLS_DIR}: more than 256 tools`);

  for (const tool of tools) {
    const err = (msg) => errors.push(`${tool.file}: ${msg}`);
    const { type } = tool.data;
    const extra = (allowed) => {
      for (const key of Object.keys(tool.data)) if (!allowed.includes(key)) err(`unknown field \`${key}\``);
    };

    if (type === TOOLSET) {
      checkToolset(tool, err);
      extra(["type"]);
    } else if (type === MCP_TOOLSET) {
      checkMcpToolset(tool, err);
      extra(["type", "mcp_server_name", "default_config", "url"]);
    } else if (type === "custom") {
      checkCustom(tool, err);
      extra(["type", "name", "description"]);
    } else {
      err(`\`type\` must be \`${TOOLSET}\` (the pre-built tools), \`${MCP_TOOLSET}\` (an MCP server) or \`custom\``);
    }
  }
}

// The tools of an MCP server that agent.md declares: `mcp_server_name` is the server's name, and the
// optional `## Tools` table configures tools by the names the server reports.
function checkMcpToolset(tool, err) {
  const { mcp_server_name: server, default_config: defaults } = tool.data;
  if ("url" in tool.data) err("`url` belongs in agent.md's `mcp_servers`; refer to the server here with `mcp_server_name`");
  if (typeof server !== "string" || server === "") err("`mcp_server_name` is required");
  else if (server !== tool.name) err(`\`mcp_server_name\` must match the file name (${tool.name})`);
  if (tool.name.length > 255) err("an MCP server's name (its file name) must be at most 255 characters");

  if (defaults !== undefined && defaults !== null) {
    if (typeof defaults !== "object" || Array.isArray(defaults)) err("`default_config` must be a mapping");
    else {
      if (defaults.enabled !== undefined && typeof defaults.enabled !== "boolean") err("`default_config.enabled` must be true or false");
      const policy = defaults.permission_policy;
      if (policy !== undefined && !POLICIES.includes(policy?.type)) {
        err(`\`default_config.permission_policy.type\` must be ${POLICIES.join(", ")}`);
      }
      for (const key of Object.keys(defaults)) {
        if (!["enabled", "permission_policy"].includes(key)) err(`unknown field \`default_config.${key}\``);
      }
    }
  }
  checkRows(tool.rows ?? [], err, { known: null });
}

function checkToolset(tool, err) {
  if (!tool.rows) {
    // 0.2.0 had one file per pre-built tool, with no table.
    const hint = PREBUILT_TOOLS.includes(tool.name) ? `; since 0.2.1 all pre-built tools go in one file, ${TOOLS_DIR}/${TOOLSET_FILE}` : "";
    return err(`a \`## Tools\` table listing the pre-built tools to enable is required${hint}`);
  }
  checkRows(tool.rows, err, { known: PREBUILT_TOOLS });
}

// The rows of a `## Tools` table. `known` is the list of valid tool names, when there is one.
function checkRows(rows, err, { known }) {
  const seen = new Set();
  for (const row of rows) {
    if (!row.name) err("a `## Tools` row has no name");
    else if (known && !known.includes(row.name)) err(`\`${row.name}\` is not a pre-built tool; use ${known.join(", ")}`);
    else if (seen.has(row.name)) err(`\`${row.name}\` is listed twice`);
    seen.add(row.name);
    if (!["true", "false"].includes(row.enabled.toLowerCase())) err(`\`${row.name}\`: Enabled must be true or false`);
    if (row.permission && !POLICIES.includes(row.permission)) {
      err(`\`${row.name}\` has permission \`${row.permission}\`; use ${POLICIES.join(", ")}, or leave it blank`);
    }
  }
}

function checkCustom(tool, err) {
  const { name, description } = tool.data;
  if (name !== tool.name) err(`\`name\` must match the file name (${tool.name})`);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) err("the name may only use letters, digits, _ and -, up to 64 characters");
  if (PREBUILT_TOOLS.includes(tool.name)) err(`\`${tool.name}\` is a pre-built tool's name; the API rejects custom tools that reuse one`);
  if (/^(mcp__|ant__)/.test(tool.name)) err("custom tool names can't start with mcp__ or ant__");
  if (typeof description !== "string" || description.trim() === "") err("`description` is required");

  const seen = new Set();
  for (const p of tool.params ?? []) {
    if (!p.name) err("an Input Schema row has no name");
    else if (seen.has(p.name)) err(`input \`${p.name}\` is listed twice`);
    seen.add(p.name);
    if (!TYPES.includes(p.type?.replace(/\[\]$/, ""))) {
      err(`input \`${p.name}\` has type \`${p.type}\`; use ${TYPES.join(", ")}, or one of them followed by []`);
    }
    if (!["true", "false"].includes(p.required?.toLowerCase())) err(`input \`${p.name}\`: Required must be true or false`);
  }

  if (!tool.code) return err("a `## Code` section with a JavaScript code block is required");
  if (!["javascript", "js"].includes(tool.code.lang)) err("the code must be JavaScript (```javascript)");
  else {
    try {
      new Script(wrap(tool.code.source), { filename: tool.file });
    } catch (e) {
      err(`the code doesn't parse: ${e.message}`);
    }
  }
}

// The tools list sent to the API, each kind sorted by name: the pre-built toolset with a config
// for each row of its table (tools it doesn't list keep the API's defaults), then a toolset for
// each MCP server, then the custom tools.
export function compileTools(tools) {
  const compiled = [];
  const toolset = tools.find((t) => t.data.type === TOOLSET);
  if (toolset) compiled.push({ type: TOOLSET, configs: configs(toolset.rows) });
  for (const tool of byName(tools.filter((t) => t.data.type === MCP_TOOLSET))) {
    const entry = { type: MCP_TOOLSET, mcp_server_name: tool.name };
    if (tool.data.default_config) entry.default_config = tool.data.default_config;
    if (tool.rows?.length) entry.configs = configs(tool.rows);
    compiled.push(entry);
  }
  for (const tool of tools.filter((t) => t.data.type === "custom").sort((a, b) => (a.name < b.name ? -1 : 1))) {
    compiled.push({ type: "custom", name: tool.name, description: tool.data.description, input_schema: inputSchema(tool.params ?? []) });
  }
  return compiled;
}

const byName = (tools) => [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function configs(rows = []) {
  return [...rows].sort((a, b) => (a.name < b.name ? -1 : 1)).map(({ name, enabled, permission }) => {
    const config = { name, enabled: enabled.toLowerCase() === "true" };
    if (permission) config.permission_policy = { type: permission };
    return config;
  });
}

function inputSchema(params) {
  const properties = {};
  for (const p of params) {
    const list = p.type.endsWith("[]");
    const type = p.type.replace(/\[\]$/, "");
    const prop = list ? { type: "array", items: { type } } : { type };
    if (p.description) prop.description = p.description;
    properties[p.name] = prop;
  }
  const required = params.filter((p) => p.required.toLowerCase() === "true").map((p) => p.name);
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

// Loads a custom tool's code as a CommonJS module whose module.exports is the function.
// require() resolves relative to the tool's file, so the agent folder's node_modules work.
export function loadTool(tool) {
  const module = { exports: {} };
  const fn = runInThisContext(wrap(tool.code.source), { filename: tool.path });
  fn(module.exports, createRequire(tool.path), module, tool.path, resolve(tool.path, ".."));
  if (typeof module.exports !== "function") {
    throw new Error(`${tool.file}: module.exports must be a function`);
  }
  return module.exports;
}

const wrap = (source) => `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
