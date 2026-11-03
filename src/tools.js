import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { Script, runInThisContext } from "node:vm";
import { FileError, parseMarkdown } from "./markdown.js";

export const TOOLS_DIR = "tools";
export const BUILT_IN_DIR = "built-in";
export const TOOLSET = "agent_toolset_20260401";
export const PREBUILT_TOOLS = ["bash", "edit", "glob", "grep", "read", "web_fetch", "web_search", "write"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array"];

// Reads every .md file under tools/, in any subfolder, sorted by name. Folders are only for
// organizing: a tool's name is its file name, and its path isn't compiled into anything.
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

  // Names must be unique across folders, since the folders are dropped.
  for (const [name, same] of groupBy(tools, (t) => t.name)) {
    if (same.length > 1) errors.push(`${TOOLS_DIR}: more than one tool is named \`${name}\` (${same.map((t) => t.file).join(", ")})`);
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

// Pulls the `## Input Schema` table and the `## Code` block out of a tool file's body.
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

  const result = { params: null, code: null };
  if (sections["input schema"]) result.params = parseTable(sections["input schema"], file);
  if (sections.code) result.code = parseCode(sections.code, file);
  return result;
}

// Rows of the Name | Type | Description | Required table.
function parseTable(lines, file) {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map(splitRow);
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.toLowerCase());
  const want = ["name", "type", "description", "required"];
  if (want.some((c, i) => header[i] !== c)) {
    throw new FileError(`${file}: the Input Schema table's columns must be Name | Type | Description | Required`);
  }
  return rows.slice(2).map(([name, type, description, required]) => ({ name, type, description, required }));
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
      if (!PREBUILT_TOOLS.includes(tool.name)) {
        err(`not a pre-built tool; name the file after one of: ${PREBUILT_TOOLS.join(", ")}`);
      }
      extra(["type"]);
    } else if (type === "custom") {
      checkCustom(tool, err);
      extra(["type", "name", "description"]);
    } else {
      err(`\`type\` must be \`${TOOLSET}\` (a pre-built tool) or \`custom\``);
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

// The tools list sent to the API: one toolset entry that enables only the pre-built tools
// with a file (so deleting a file disables the tool), then the custom tools, sorted by name.
export function compileTools(tools) {
  const compiled = [];
  const prebuilt = tools.filter((t) => t.data.type === TOOLSET).map((t) => t.name).sort();
  if (prebuilt.length > 0) {
    compiled.push({
      type: TOOLSET,
      default_config: { enabled: false },
      configs: prebuilt.map((name) => ({ name, enabled: true })),
    });
  }
  for (const tool of tools.filter((t) => t.data.type === "custom").sort((a, b) => (a.name < b.name ? -1 : 1))) {
    compiled.push({ type: "custom", name: tool.name, description: tool.data.description, input_schema: inputSchema(tool.params ?? []) });
  }
  return compiled;
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
