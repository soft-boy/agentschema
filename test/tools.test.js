import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runTool } from "../src/chat.js";
import { check } from "../src/check.js";
import { agentBody } from "../src/instance.js";
import { AGENT_MD, ENV_MD, PREBUILT_MD, instance, toolset } from "./helpers.js";

const READ_FILE_MD = `---
type: custom
name: read_file
description: Read a file and output its contents as a string.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| \`filePath\` | \`string\` | The path of the file to read | \`true\` |
| \`lines\` | \`integer[]\` | Line numbers to keep | \`false\` |

## Code

\`\`\`javascript
const fs = require('fs').promises;

// ## not a heading: this is inside the code block
const readFile = async ({ filePath }) => {
    try {
        return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
        return \`Error reading file: \${error.message}\`;
    }
};

module.exports = readFile;
\`\`\`
`;

const folder = (tools) => instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, ...tools });
const errorsFor = (tools) => check(folder(tools)).errors;

test("tools compile to one toolset entry, then custom tools, sorted by name", () => {
  const { errors, instance: inst } = check(folder({
    "tools/agent_toolset_20260401.md": toolset("web_search", "bash | true | always_ask", "read | false"),
    "tools/read_file.md": READ_FILE_MD,
    "tools/ask_user.md": READ_FILE_MD.replace("name: read_file", "name: ask_user"),
  }));
  assert.deepEqual(errors, []);
  const { tools } = agentBody(inst);
  assert.deepEqual(tools[0], {
    type: "agent_toolset_20260401",
    configs: [
      { name: "bash", enabled: true, permission_policy: { type: "always_ask" } },
      { name: "read", enabled: false },
      { name: "web_search", enabled: true },
    ],
  });
  assert.deepEqual(tools.slice(1).map((t) => t.name), ["ask_user", "read_file"]);
  assert.deepEqual(tools[2].input_schema, {
    type: "object",
    properties: {
      filePath: { type: "string", description: "The path of the file to read" },
      lines: { type: "array", items: { type: "integer" }, description: "Line numbers to keep" },
    },
    required: ["filePath"],
  });
});

test("no tools/ folder sends an empty tools list", () => {
  const { errors, instance: inst } = check(instance({ "agent.md": AGENT_MD, "env.md": ENV_MD }));
  assert.deepEqual(errors, []);
  assert.deepEqual(agentBody(inst).tools, []);
});

test("tools in agent.md's frontmatter are an error", () => {
  const md = AGENT_MD.replace("model: claude-opus-5-5\n", "model: claude-opus-5-5\ntools: []\n");
  assert.match(check(instance({ "agent.md": md, "env.md": ENV_MD })).errors[0], /define each tool as a file in tools\//);
});

test("the pre-built toolset file is checked", () => {
  const errs = (md, file = "tools/agent_toolset_20260401.md") => errorsFor({ [file]: md }).join("\n");
  assert.match(errs(toolset("shell")), /`shell` is not a pre-built tool/);
  assert.match(errs(toolset("bash", "bash")), /`bash` is listed twice/);
  assert.match(errs(toolset("bash | true | sometimes")), /permission `sometimes`/);
  assert.match(errs(toolset("bash | yes")), /`bash`: Enabled must be true or false/);
  assert.match(errs(toolset("bash |")), /`bash`: Enabled must be true or false/);
  assert.match(errs(PREBUILT_MD.replace("---\n\n", "enabled: false\n---\n\n")), /unknown field `enabled`/);
  assert.match(errs(PREBUILT_MD.replace("| Name | Enabled |", "| Name | On |")), /Tools table's columns/);
  assert.match(errs("---\ntype: mcp_toolset\n---\n"), /`type` must be/);
  // A 0.2.0-style file, one per tool with no table, points at the new layout.
  assert.match(errs("---\ntype: agent_toolset_20260401\n---\n", "tools/bash.md"), /since 0\.2\.1 all pre-built tools go in one file/);
  assert.match(errorsFor({ "tools/a.md": PREBUILT_MD, "tools/b.md": PREBUILT_MD })[0], /more than one `agent_toolset_20260401` file/);
});

test("the Permission column is optional", () => {
  const md = "---\ntype: agent_toolset_20260401\n---\n\n## Tools\n\n| Name | Enabled |\n|---|---|\n| `read` | `true` |\n";
  const { errors, instance: inst } = check(folder({ "tools/agent_toolset_20260401.md": md }));
  assert.deepEqual(errors, []);
  assert.deepEqual(agentBody(inst).tools[0].configs, [{ name: "read", enabled: true }]);
});

test("custom tools are checked", () => {
  const errs = (md, file = "read_file") => errorsFor({ [`tools/${file}.md`]: md }).join("\n");
  assert.match(errs(READ_FILE_MD, "reader"), /`name` must match the file name \(reader\)/);
  assert.match(errs(READ_FILE_MD.replace(/read_file/g, "read"), "read"), /pre-built tool's name/);
  assert.match(errs(READ_FILE_MD.replace("description: Read a file and output its contents as a string.\n", "")), /`description` is required/);
  assert.match(errs(READ_FILE_MD.replace("`integer[]`", "`int`")), /input `lines` has type `int`/);
  assert.match(errs(READ_FILE_MD.replace("`false`", "`maybe`")), /Required must be true or false/);
  assert.match(errs(READ_FILE_MD.replace("```javascript", "```python")), /must be JavaScript/);
  assert.match(errs(READ_FILE_MD.replace("module.exports = readFile;", "module.exports = (;")), /doesn't parse/);
  assert.match(errs(READ_FILE_MD.slice(0, READ_FILE_MD.indexOf("## Code"))), /`## Code` section .* is required/);
});

test("a custom tool's code runs, with require() resolved from the tool's file", async () => {
  const dir = folder({ "tools/read_file.md": READ_FILE_MD, "notes.txt": "hello" });
  const tool = check(dir).instance.tools[0];
  assert.deepEqual(await runTool(tool, { filePath: join(dir, "notes.txt") }), { text: "hello" });
});

test("a tool that throws returns an error result; non-strings are sent as JSON", async () => {
  const code = (body) => READ_FILE_MD.replace(/```javascript[\s\S]*```/, `\`\`\`javascript\n${body}\n\`\`\``);
  const tools = check(folder({
    "tools/fails.md": code("module.exports = () => { throw new Error('disk full'); };").replace(/read_file/g, "fails"),
    "tools/count.md": code("module.exports = async () => ({ files: 3 });").replace(/read_file/g, "count"),
  })).instance.tools;
  assert.deepEqual(await runTool(tools[1], {}), { text: "Error: disk full", isError: true });
  assert.deepEqual(await runTool(tools[0], {}), { text: '{"files":3}' });
});

test("subfolders only organize: the same tools compile whatever folder they're in", () => {
  const flat = check(folder({ "tools/agent_toolset_20260401.md": PREBUILT_MD, "tools/read_file.md": READ_FILE_MD })).instance;
  const nested = check(folder({
    "tools/config/toolset.md": PREBUILT_MD,
    "tools/files/io/read_file.md": READ_FILE_MD,
    "tools/.drafts/other.md": toolset("web_search"),
  })).instance;
  assert.deepEqual(agentBody(nested).tools, agentBody(flat).tools);
});

test("two tools with the same name in different folders are an error", () => {
  const errors = errorsFor({ "tools/a/read_file.md": READ_FILE_MD, "tools/read_file.md": READ_FILE_MD });
  assert.match(errors[0], /more than one tool is named `read_file` \(tools\/a\/read_file\.md, tools\/read_file\.md\)/);
});
