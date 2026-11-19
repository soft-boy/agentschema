import { stringify } from "yaml";
import { type FileMap, pathsUnder, textOf } from "./files.ts";
import { FileError, type Frontmatter, type MarkdownFile, parseMarkdown } from "./markdown.ts";

export const TOOLS_DIR = "tools";
export const TOOLSET = "agent_toolset_20260401";
export const TOOLSET_FILE = `${TOOLSET}.md`;
export const MCP_TOOLSET = "mcp_toolset";
export const AGENTBOOK = "agentbook";
// A folder of an agentbook toolset's tools has this file, saying which toolset it is.
export const TOOLSET_FOLDER_FILE = "toolset.md";
// The tools Claude runs on the agent's computer, its container, which computer.md describes.
export const COMPUTER_TOOLS = ["bash", "edit", "glob", "grep", "read", "web_fetch", "web_search", "write"];
/** @deprecated Their old name: use COMPUTER_TOOLS. */
export const PREBUILT_TOOLS = COMPUTER_TOOLS;
export const POLICIES = ["always_allow", "always_ask", "auto"];
// agentbook tools reach the API as custom tools, which have no permission policy: agentbook
// enforces these itself, and has nothing like the API's per-call `auto` judgement.
const AGENTBOOK_POLICIES = ["always_allow", "always_ask"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array"];

// A row of a custom tool's `## Input Schema` table, as written: every cell is text.
export interface ToolParam {
  name: string;
  type: string;
  description: string;
  required: string;
}

// A row of a `## Tools` table, as written. `permission` is missing when the table has no such column.
export interface ToolRow {
  name: string;
  enabled: string;
  permission?: string;
}

// One tool's file in a toolset folder: on or off, its permission, and in its body, notes for the
// agent about using it.
export interface ToolMember extends MarkdownFile {
  file: string;
  name: string;
}

// A custom tool's `## Code` block.
export interface ToolCode {
  lang: string;
  source: string;
}

// A file in tools/, of any kind: `data.type` says which (TOOLSET, MCP_TOOLSET, "custom" or AGENTBOOK),
// and the sections are null when the body doesn't have them.
export interface Tool extends MarkdownFile {
  file: string;
  name: string;
  params: ToolParam[] | null;
  code: ToolCode | null;
  rows: ToolRow[] | null;
  // For a toolset folder, its tools' files. `file` is then the folder's toolset.md, `name` is the folder's
  // name, and `rows` is made from these, so everything that reads a toolset's table reads a folder too.
  members?: ToolMember[];
  // Where the file is on disk, which the CLI adds so a custom tool's require() calls resolve from there.
  path?: string;
}

export interface ReadToolsResult {
  tools: Tool[];
  errors: string[];
}

export type JsonSchema = Record<string, unknown>;

// A tool in agentbook's catalog. `liveAllowed` and `safeForAnyone` are read by channels' checks.
export interface AgentbookToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  liveAllowed?: boolean;
  safeForAnyone?: boolean;
}

// agentbook's catalog of toolsets, by name.
export type AgentbookCatalog = Record<string, { tools: AgentbookToolDefinition[] }>;

// A tool that a `type: agentbook` file turns on: the catalog's definition, and where it came from.
// `file` is the tool's own file in a toolset folder, or else the toolset's file, and `group` is what the
// toolset goes by in the folder: its file's name, or its folder's. `notes` is what the owner wrote for
// the agent in the tool's file, which `description` ends with.
export interface AgentbookTool extends AgentbookToolDefinition {
  file: string;
  group: string;
  toolset: string;
  permission: string;
  notes: string;
}

export interface CompileOptions {
  toolsets?: AgentbookCatalog;
}

export interface CheckToolsOptions extends CompileOptions {
  customTools?: boolean;
}

export interface PermissionPolicy {
  type: string;
}

export interface ToolConfig {
  name: string;
  enabled: boolean;
  permission_policy?: PermissionPolicy;
}

export interface SchemaProperty {
  type: string;
  items?: { type: string };
  description?: string;
}

// A type alias rather than an interface, so that it fits JsonSchema.
export type InputSchema = {
  type: "object";
  properties: Record<string, SchemaProperty>;
  required?: string[];
};

// The entries in the API's `tools` list.
export interface CompiledToolset {
  type: typeof TOOLSET;
  configs: ToolConfig[];
}

export interface CompiledMcpToolset {
  type: typeof MCP_TOOLSET;
  mcp_server_name: string;
  default_config?: Frontmatter;
  configs?: ToolConfig[];
}

export interface CompiledCustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export type CompiledTool = CompiledToolset | CompiledMcpToolset | CompiledCustomTool;

type Report = (message: string) => void;

// Reads every .md file under tools/, in any subfolder, sorted by name. Folders are only for
// organizing: a custom tool's name is its file name, and its path isn't compiled into anything.
// The computer toolset is one file (by convention tools/agent_toolset_20260401.md) that lists its tools.
// No tools/ folder means no tools.
// Returns { tools, errors }; a tool file that can't be parsed has an entry in errors.
export function readTools(files: FileMap): ReadToolsResult {
  if (TOOLS_DIR in files) return { tools: [], errors: [`${TOOLS_DIR}: not a directory`] };

  const tools: Tool[] = [];
  const errors: string[] = [];
  const parse = (file: string) => {
    try {
      return parseMarkdown(textOf(files[file]), file);
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
      return null;
    }
  };
  // A tool file, with its tables and code. A table that can't be read is an error too.
  const asTool = (file: string, name: string, parsed: MarkdownFile, extra: Partial<Tool> = {}): Tool | null => {
    try {
      return { file, name, ...parsed, ...parseSections(parsed.body, file), ...extra };
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
      return null;
    }
  };
  const paths = pathsUnder(files, TOOLS_DIR).filter((path) => path.endsWith(".md"));
  const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

  // A folder with a toolset.md of `type: agentbook` is one toolset, and every other file in it is one of
  // its tools. tools/ itself can't be one, since its files are tools of every kind.
  const folders = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith(`/${TOOLSET_FOLDER_FILE}`) || folderOf(path) === TOOLS_DIR) continue;
    const parsed = parse(path);
    if (!parsed || parsed.data.type !== AGENTBOOK) continue;
    const folder = folderOf(path);
    folders.add(folder);
    const members: ToolMember[] = [];
    for (const file of paths) {
      if (file === path || !file.startsWith(`${folder}/`)) continue;
      if (folderOf(file) !== folder) {
        errors.push(`${file}: a toolset's folder holds its tools' files directly, without folders inside it`);
        continue;
      }
      // A tool's file can be only notes, without properties.
      const text = textOf(files[file]).replace(/^\uFEFF/, "");
      const member = /^---\r?\n/.test(text) ? parse(file) : { data: {}, body: text.trim(), raw: text };
      if (member) members.push({ file, name: nameOf(file), ...member });
    }
    members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rows = members.map(({ name, data }) => ({ name, enabled: data.enabled === false ? "false" : "true", permission: typeof data.permission === "string" ? data.permission : "" }));
    const tool = asTool(path, nameOf(folder), parsed, { rows, members });
    if (tool) tools.push(tool);
  }

  const inFolder = (path: string) => [...folders].some((folder) => path.startsWith(`${folder}/`));
  for (const file of paths) {
    if (inFolder(file)) continue;
    const parsed = parse(file);
    const tool = parsed && asTool(file, nameOf(file), parsed);
    if (tool) tools.push(tool);
  }

  // Names must be unique across folders, since the folders are dropped.
  for (const [type, what] of [["custom", "tool"], [MCP_TOOLSET, "MCP server"], [AGENTBOOK, "agentbook toolset"]]) {
    for (const [name, same] of groupBy(tools.filter((t) => t.data.type === type), (t) => t.name)) {
      if (same.length > 1) errors.push(`${TOOLS_DIR}: more than one ${what} is named \`${name}\` (${same.map((t) => t.file).join(", ")})`);
    }
  }
  for (const [toolset, same] of groupBy(tools.filter((t) => t.data.type === AGENTBOOK && typeof t.data.toolset === "string"), (t) => t.data.toolset as string)) {
    if (same.length > 1 && new Set(same.map((t) => t.name)).size > 1) {
      errors.push(`${TOOLS_DIR}: more than one file turns on the agentbook toolset \`${toolset}\` (${same.map((t) => t.file).join(", ")})`);
    }
  }
  const toolsets = tools.filter((t) => t.data.type === TOOLSET);
  if (toolsets.length > 1) {
    errors.push(`${TOOLS_DIR}: more than one \`${TOOLSET}\` file (${toolsets.map((t) => t.file).join(", ")}); list every computer tool in one file`);
  }
  return { tools: tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), errors };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

// Pulls the `## Input Schema` table, the `## Code` block and the `## Tools` table (for a toolset)
// out of a tool file's body.
function parseSections(body: string, file: string): Pick<Tool, "params" | "code" | "rows"> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  let fence: string | null = null;
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

  const result: Pick<Tool, "params" | "code" | "rows"> = { params: null, code: null, rows: null };
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
function parseTable<R extends string, O extends string = never>(
  lines: string[],
  message: string,
  required: R[],
  optional: O[] = [],
): (Record<R, string> & Partial<Record<O, string>>)[] {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map(splitRow);
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.toLowerCase());
  const allowed: string[] = [...required, ...optional];
  if (header.length < required.length || header.length > allowed.length || header.some((c, i) => c !== allowed[i])) {
    throw new FileError(message);
  }
  return rows.slice(2).map((cells) => Object.fromEntries(header.map((c, i) => [c, cells[i] ?? ""])) as Record<R, string> & Partial<Record<O, string>>);
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|").replace(/^`(.*)`$/, "$1"));
}

function parseCode(lines: string[], file: string): ToolCode {
  const text = lines.join("\n");
  const blocks = [...text.matchAll(/^(```|~~~)[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)];
  if (blocks.length !== 1) throw new FileError(`${file}: the Code section must hold exactly one fenced code block`);
  const [, , lang, source] = blocks[0];
  return { lang: lang.toLowerCase(), source };
}

// Errors and warnings for the tool files, in check's format.
// `options.customTools: false` refuses custom tools, for hosts that won't run user code.
// `options.toolsets` is the catalog behind `type: agentbook` files; see agentbookTools.
export function checkTools(tools: Tool[], errors: string[], warnings: string[] = [], options: CheckToolsOptions = {}): void {
  const customs = tools.filter((t) => t.data.type === "custom");
  if (customs.length + (customs.length < tools.length ? 1 : 0) > 256) errors.push(`${TOOLS_DIR}: more than 256 tools`);

  // agentbook tools and custom tools all reach the API as custom tools, in one namespace.
  if (options.toolsets) {
    const names = new Set(customs.map((t) => t.name));
    for (const { file, name } of agentbookTools(tools, options.toolsets)) {
      if (names.has(name)) errors.push(`${file}: another tool is already named \`${name}\``);
      names.add(name);
    }
  }

  for (const tool of tools) {
    const err = (msg: string) => errors.push(`${tool.file}: ${msg}`);
    const { type } = tool.data;
    const extra = (allowed: string[]) => {
      for (const key of Object.keys(tool.data)) if (!allowed.includes(key)) err(`unknown field \`${key}\``);
    };

    if (type === TOOLSET) {
      checkToolset(tool, err);
      extra(["type"]);
    } else if (type === MCP_TOOLSET) {
      checkMcpToolset(tool, err);
      extra(["type", "mcp_server_name", "default_config", "url"]);
    } else if (type === "custom") {
      if (options.customTools === false) err("custom tools aren't available here, because they'd run your code on a shared server");
      else checkCustom(tool, err);
      extra(["type", "name", "description"]);
    } else if (type === AGENTBOOK) {
      checkAgentbook(tool, err, (msg) => warnings.push(`${tool.file}: ${msg}`), options, (file, msg) => errors.push(`${file}: ${msg}`));
      extra(["type", "toolset"]);
    } else {
      err(`\`type\` must be \`${TOOLSET}\` (the computer tools), \`${MCP_TOOLSET}\` (an MCP server), \`custom\` or \`${AGENTBOOK}\``);
    }
  }
}

// The tools of an MCP server that agent.md declares: `mcp_server_name` is the server's name, and the
// optional `## Tools` table configures tools by the names the server reports.
function checkMcpToolset(tool: Tool, err: Report): void {
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

// A toolset from agentbook's catalog. `## Tools` turns its tools on one by one, so a tool without
// a row is off: a new tool in the catalog never reaches a deployed agent by itself.
//
// It's either one file with a `## Tools` table, named after the toolset, or a folder: a toolset.md, and a
// file for each tool, named after it, whose body is notes for the agent. A tool without a row, or a
// file, is off.
function checkAgentbook(tool: Tool, err: Report, warn: Report, { toolsets }: CheckToolsOptions, errAt: (file: string, msg: string) => void): void {
  const { toolset } = tool.data;
  if (typeof toolset !== "string" || toolset === "") return err("`toolset` is required");
  if (tool.members) {
    const hasTable = /^##\s+tools\s*$/im.test(tool.body);
    if (hasTable) err("a toolset's folder lists its tools as files beside this one, not as a `## Tools` table");
  } else {
    if (toolset !== tool.name) err(`\`toolset\` must match the file name (${tool.name})`);
    if (!tool.rows) err("a `## Tools` table listing the tools to enable is required");
  }

  if (!toolsets) warn("this toolset runs on agentbook, so `agentschema deploy` can't deploy it");
  else if (!Object.hasOwn(toolsets, toolset)) err(`\`${toolset}\` isn't an agentbook toolset; use ${Object.keys(toolsets).join(", ")}`);
  const known = toolsets && Object.hasOwn(toolsets, toolset) ? toolsets[toolset].tools.map((t) => t.name) : null;
  if (!tool.members) return checkRows(tool.rows ?? [], err, { known, what: `a tool in \`${toolset}\``, policies: AGENTBOOK_POLICIES });

  for (const member of tool.members) {
    const memberErr = (msg: string) => errAt(member.file, msg);
    if (known && !known.includes(member.name)) memberErr(`\`${member.name}\` is not a tool in \`${toolset}\`; use ${known.join(", ")}`);
    const { enabled, permission } = member.data;
    if (enabled !== undefined && typeof enabled !== "boolean") memberErr("`enabled` must be true or false");
    if (permission !== undefined && permission !== null && !AGENTBOOK_POLICIES.includes(permission)) {
      memberErr(`\`permission\` must be ${AGENTBOOK_POLICIES.join(" or ")}, or left out`);
    }
    for (const key of Object.keys(member.data)) if (!["enabled", "permission"].includes(key)) memberErr(`unknown field \`${key}\``);
  }
}

function checkToolset(tool: Tool, err: Report): void {
  if (!tool.rows) {
    // 0.2.0 had one file per computer tool, with no table.
    const hint = COMPUTER_TOOLS.includes(tool.name) ? `; since 0.2.1 all computer tools go in one file, ${TOOLS_DIR}/${TOOLSET_FILE}` : "";
    return err(`a \`## Tools\` table listing the computer tools to enable is required${hint}`);
  }
  checkRows(tool.rows, err, { known: COMPUTER_TOOLS, what: "a computer tool" });
}

// The rows of a `## Tools` table. `known` is the list of valid tool names, when there is one.
function checkRows(rows: ToolRow[], err: Report, { known, what, policies = POLICIES }: { known: string[] | null; what?: string; policies?: string[] }): void {
  const seen = new Set();
  for (const row of rows) {
    if (!row.name) err("a `## Tools` row has no name");
    else if (known && !known.includes(row.name)) err(`\`${row.name}\` is not ${what}; use ${known.join(", ")}`);
    else if (seen.has(row.name)) err(`\`${row.name}\` is listed twice`);
    seen.add(row.name);
    if (!["true", "false"].includes(row.enabled.toLowerCase())) err(`\`${row.name}\`: Enabled must be true or false`);
    if (row.permission && !policies.includes(row.permission)) {
      err(`\`${row.name}\` has permission \`${row.permission}\`; use ${policies.join(", ")}, or leave it blank`);
    }
  }
}

function checkCustom(tool: Tool, err: Report): void {
  const { name, description } = tool.data;
  if (name !== tool.name) err(`\`name\` must match the file name (${tool.name})`);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) err("the name may only use letters, digits, _ and -, up to 64 characters");
  if (COMPUTER_TOOLS.includes(tool.name)) err(`\`${tool.name}\` is a computer tool's name; the API rejects custom tools that reuse one`);
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
    // Parses the code without running it: the function this builds is never called.
    try {
      new Function(wrapToolCode(tool.code.source));
    } catch (e) {
      // A page's content security policy can forbid this, which says nothing about the code.
      if (e instanceof SyntaxError) err(`the code doesn't parse: ${e.message}`);
    }
  }
}

// An MCP server's tool file. With the server's tools, it's a table of them, all on, each with
// `permission`. A tool the server adds later isn't in the table, so it gets the API's defaults: on, and
// asking before each call. Many servers won't list their tools until you've signed in, so with no tools
// it keeps `permission` for all of them, ready for the table: see listedMcpToolset.
export function mcpToolsetFile({ name, tools = [], permission = "always_ask" }: { name: string; tools?: string[]; permission?: string }): string {
  const front: { type: string; mcp_server_name: string; default_config?: { permission_policy: PermissionPolicy } } = { type: MCP_TOOLSET, mcp_server_name: name };
  if (tools.length > 0) {
    const rows = tools.map((tool) => `| \`${tool}\` | \`true\` | \`${permission}\` |`);
    const body = ["Set Enabled to false to turn a tool off.", "", "## Tools", "", "| Name | Enabled | Permission |", "|---|---|---|", ...rows, ""].join("\n");
    return `---\n${stringify(front)}---\n\n${body}`;
  }
  if (permission !== "always_ask") front.default_config = { permission_policy: { type: permission } };
  return `---\n${stringify(front)}---\n\nEvery tool the server offers is on. Its tools get listed here once it's been signed in to.\n`;
}

// The agentbook tools a folder turns on, as { file, group, toolset, name, description, input_schema,
// permission, notes }. `toolsets` is the catalog, { [toolset]: { tools: [{ name, description,
// input_schema }] } }. A blank permission means `always_ask`, the safe choice for a tool with no policy of
// its own. A tool's own file in a toolset folder can add notes, which follow the catalog's description.
export function agentbookTools(tools: Tool[], toolsets: AgentbookCatalog = {}): AgentbookTool[] {
  return byName(tools.filter((t) => t.data.type === AGENTBOOK)).flatMap((tool) => {
    const { toolset } = tool.data;
    if (!Object.hasOwn(toolsets, toolset)) return [];
    return toolsets[toolset].tools.flatMap((definition) => {
      const row = tool.rows?.find((r) => r.name === definition.name);
      if (row?.enabled.toLowerCase() !== "true") return [];
      const member = tool.members?.find((m) => m.name === definition.name);
      const notes = member?.body.trim() ?? "";
      const description = notes ? `${definition.description}\n\n${OWNER_NOTES}\n${notes}` : definition.description;
      return [{ ...definition, description, file: member?.file ?? tool.file, group: tool.name, toolset, permission: row.permission || "always_ask", notes }];
    });
  });
}

// What comes before a tool's notes from its file, in the description the agent gets.
export const OWNER_NOTES = "Notes from the agent's owner:";

// The files of an agentbook toolset as a folder: tools/<folder>/toolset.md, saying which toolset, with
// `note` for people in its body, and a file for each tool in `tools`, with its permission and notes.
export function agentbookToolsetFiles({ folder, toolset, note = "", tools }: { folder: string; toolset: string; note?: string; tools: { name: string; permission?: string; enabled?: boolean; notes?: string }[] }): FileMap {
  const dir = `${TOOLS_DIR}/${folder}`;
  const files: FileMap = { [`${dir}/${TOOLSET_FOLDER_FILE}`]: `---\n${stringify({ type: AGENTBOOK, toolset })}---\n${note ? `\n${note.trim()}\n` : ""}` };
  for (const { name, permission, enabled, notes = "" } of tools) {
    const front: Frontmatter = {};
    if (enabled === false) front.enabled = false;
    if (permission) front.permission = permission;
    const head = Object.keys(front).length > 0 ? `---\n${stringify(front)}---\n` : "";
    files[`${dir}/${name}.md`] = `${head}${notes ? `${head ? "\n" : ""}${notes.trim()}\n` : ""}`;
  }
  return files;
}

// The tools list sent to the API, each kind sorted by name: the computer toolset with a config
// for each row of its table (tools it doesn't list keep the API's defaults), then a toolset for
// each MCP server, then the custom tools, and last agentbook's tools, which reach the API as
// custom tools. Only their name, description and input schema are sent.
export function compileTools(tools: Tool[], { toolsets }: CompileOptions = {}): CompiledTool[] {
  const compiled: CompiledTool[] = [];
  const toolset = tools.find((t) => t.data.type === TOOLSET);
  // check requires the computer toolset's table, so its rows are there.
  if (toolset) compiled.push({ type: TOOLSET, configs: configs(toolset.rows!) });
  for (const tool of byName(tools.filter((t) => t.data.type === MCP_TOOLSET))) {
    const entry: CompiledMcpToolset = { type: MCP_TOOLSET, mcp_server_name: tool.name };
    if (tool.data.default_config) entry.default_config = tool.data.default_config;
    if (tool.rows?.length) entry.configs = configs(tool.rows);
    compiled.push(entry);
  }
  for (const tool of tools.filter((t) => t.data.type === "custom").sort((a, b) => (a.name < b.name ? -1 : 1))) {
    compiled.push({ type: "custom", name: tool.name, description: tool.data.description, input_schema: inputSchema(tool.params ?? []) });
  }
  for (const { name, description, input_schema } of agentbookTools(tools, toolsets)) {
    compiled.push({ type: "custom", name, description, input_schema });
  }
  return compiled;
}

const byName = (tools: Tool[]): Tool[] => [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

function configs(rows: ToolRow[] = []): ToolConfig[] {
  return [...rows].sort((a, b) => (a.name < b.name ? -1 : 1)).map(({ name, enabled, permission }) => {
    const config: ToolConfig = { name, enabled: enabled.toLowerCase() === "true" };
    if (permission) config.permission_policy = { type: permission };
    return config;
  });
}

function inputSchema(params: ToolParam[]): InputSchema {
  const properties: Record<string, SchemaProperty> = {};
  for (const p of params) {
    const list = p.type.endsWith("[]");
    const type = p.type.replace(/\[\]$/, "");
    const prop: SchemaProperty = list ? { type: "array", items: { type } } : { type };
    if (p.description) prop.description = p.description;
    properties[p.name] = prop;
  }
  const required = params.filter((p) => p.required.toLowerCase() === "true").map((p) => p.name);
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

// A custom tool's code wrapped as a CommonJS module.
export const wrapToolCode = (source: string): string => `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
