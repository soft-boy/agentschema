import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFiles } from "../lib/check.js";
import { AGENT_MD, ENV_MD } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => join("docs", name));

// The examples in a page: a fence opened with ```markdown path=<file> holds that file.
function examplesIn(text) {
  const files = {};
  let current = null;
  for (const line of text.split("\n")) {
    if (current) {
      if (line === current.fence) current = null;
      else files[current.path] = `${files[current.path] ?? ""}${line}\n`;
    } else {
      const open = /^(`{3,})markdown path=(\S+)$/.exec(line);
      if (open) current = { fence: open[1], path: open[2] };
    }
  }
  return files;
}

for (const page of DOCS) {
  test(`the examples in ${page} pass check`, () => {
    const examples = examplesIn(readFileSync(join(ROOT, page), "utf8"));
    const { errors } = checkFiles({ "agent.md": AGENT_MD, "computer.md": ENV_MD, ...examples });
    assert.deepEqual(errors, []);
  });
}

test("the examples are where they say they are", () => {
  const all = DOCS.flatMap((page) => Object.keys(examplesIn(readFileSync(join(ROOT, page), "utf8"))));
  for (const kind of ["agent.md", "computer.md", "tools/", "skills/", "vaults/", "channels/", "scheduled/", "system_prompt/"]) {
    assert.ok(all.some((path) => path.startsWith(kind)), `no example of ${kind}`);
  }
});

for (const page of ["README.md", ...DOCS]) {
  test(`the links in ${page} lead somewhere`, () => {
    const text = readFileSync(join(ROOT, page), "utf8");
    for (const [, target, anchor] of text.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(?:#([^)\s]+))?\)/g)) {
      const file = target ? join(dirname(join(ROOT, page)), target) : join(ROOT, page);
      assert.ok(existsSync(file), `${target} doesn't exist`);
      if (!anchor) continue;
      const slugs = [...readFileSync(file, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
        heading.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-"),
      );
      assert.ok(slugs.includes(anchor), `${target}#${anchor} isn't a heading`);
    }
  });
}
