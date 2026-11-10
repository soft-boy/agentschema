import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_MD = `---
name: Coding Assistant
model: claude-opus-5-5
---

You are a helpful coding assistant.
`;

export const ENV_MD = `---
name: quickstart
config:
  type: cloud
  networking:
    type: limited
---
A note for people.
`;

// The pre-built toolset file. Each row is "name", which enables the tool, or the cells
// themselves: "bash | false" or "bash | true | always_ask".
export const toolset = (...rows) =>
  `---\ntype: agent_toolset_20260401\n---\n\n## Tools\n\n| Name | Enabled | Permission |\n|---|---|---|\n${rows
    .map((r) => (r.includes("|") ? r.split("|").map((c) => c.trim()) : [r, "true"]))
    .map(([name, enabled, permission = ""]) => `| ${name} | ${enabled} | ${permission} |`)
    .join("\n")}\n`;
export const PREBUILT_MD = toolset("bash");

// Writes { path: contents } into a fresh temporary folder and returns its path.
export function instance(files = { "agent.md": AGENT_MD, "computer.md": ENV_MD, "tools/agent_toolset_20260401.md": PREBUILT_MD }) {
  const dir = mkdtempSync(join(tmpdir(), "agentschema-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
