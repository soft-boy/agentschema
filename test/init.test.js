import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { check } from "../src/check.js";
import { InitError, defaults, init } from "../src/init.js";

const parent = () => mkdtempSync(join(tmpdir(), "agentschema-init-"));
const silent = () => new PassThrough();

test("init --yes scaffolds a folder that passes check", async () => {
  const dir = join(parent(), "bug-triage");
  await init(dir, { yes: true, output: silent() });
  assert.deepEqual(check(dir).errors, []);
  assert.deepEqual(check(dir).warnings, []);

  const agent = readFileSync(join(dir, "agent.md"), "utf8");
  assert.match(agent, /^---\nname: Bug Triage\nmodel: claude-opus-5-5\n/);
  assert.doesNotMatch(agent, /tools/);
  assert.match(readFileSync(join(dir, "tools/agent_toolset_20260401.md"), "utf8"), /^---\ntype: agent_toolset_20260401\n---\n[\s\S]*\| `bash` \| `true` \| `auto` \|/);
  assert.match(readFileSync(join(dir, "computer.md"), "utf8"), /name: bug-triage/);
});

test("init uses the answers typed, by name or number", async () => {
  const dir = join(parent(), "helper");
  const input = new PassThrough();
  // name, model, system prompt, tools, their permission, environment, networking
  input.end("Reviewer\n2\nYou review pull requests.\ny\n3\n\nunrestricted\n");
  await init(dir, { input, output: silent() });

  const { errors, instance } = check(dir);
  assert.deepEqual(errors, []);
  assert.equal(instance.agent.data.name, "Reviewer");
  assert.equal(instance.agent.data.model, "claude-sonnet-5-5");
  assert.equal(instance.agent.body, "You review pull requests.");
  assert.equal(instance.tools[0].rows.length, 8);
  assert.ok(instance.tools[0].rows.every((row) => row.permission === "always_ask"));
  assert.equal(instance.env.data.name, "helper");
  assert.deepEqual(instance.env.data.config.networking, { type: "unrestricted" });
});

test("init re-asks on an invalid choice and keeps defaults when input ends", async () => {
  const dir = join(parent(), "x");
  const input = new PassThrough();
  input.end("\nclaude-gpt\n3\n\nn\n");
  await init(dir, { input, output: silent() });

  const { instance } = check(dir);
  assert.equal(instance.agent.data.model, "claude-haiku-5-5");
  assert.equal(instance.tools.length, 0);
  assert.deepEqual(instance.env.data.config.networking, { type: "limited", allow_package_managers: true });
});

test("init refuses a folder that isn't empty", async () => {
  const dir = parent();
  writeFileSync(join(dir, "notes.txt"), "keep me");
  await assert.rejects(init(dir, { yes: true, output: silent() }), InitError);
});

test("defaults derive names from the folder", () => {
  const d = defaults("/tmp/My_Cool Agent");
  assert.equal(d.name, "My Cool Agent");
  assert.equal(d.environment, "my-cool-agent");
});
