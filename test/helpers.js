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

export const PREBUILT_MD = "---\ntype: agent_toolset_20260401\n---\n";

// Writes { path: contents } into a fresh temporary folder and returns its path.
export function instance(files = { "agent.md": AGENT_MD, "env.md": ENV_MD, "tools/bash.md": PREBUILT_MD }) {
  const dir = mkdtempSync(join(tmpdir(), "agentschema-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
