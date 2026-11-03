import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "../src/check.js";
import { agentBody } from "../src/instance.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

const errorsFor = (files) => check(instance(files)).errors;

for (const example of ["calendar-agent", "coding-agent", "weather-agent"]) {
  test(`the ${example} example is valid`, () => {
    const dir = fileURLToPath(new URL(`../examples/${example}`, import.meta.url));
    const { errors, warnings } = check(dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });
}

test("the body becomes the system prompt", () => {
  const { instance: inst } = check(instance());
  assert.deepEqual(agentBody(inst), {
    name: "Coding Assistant",
    model: "claude-opus-5-5",
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "bash", enabled: true }] }],
    system: "You are a helpful coding assistant.",
  });
});

test("an empty body sends no system prompt", () => {
  const { instance: inst } = check(instance({ "agent.md": "---\nname: a\nmodel: m\n---\n", "env.md": ENV_MD }));
  assert.equal("system" in agentBody(inst), false);
});

test("both files are required, with lowercase names", () => {
  assert.match(errorsFor({ "env.md": ENV_MD })[0], /agent\.md: missing/);
  assert.match(errorsFor({ "agent.md": AGENT_MD })[0], /env\.md: missing/);
  assert.match(errorsFor({ "AGENT.md": AGENT_MD, "env.md": ENV_MD })[0], /found AGENT\.md; the name must be lowercase/);
});

test("frontmatter must be present, closed and valid YAML", () => {
  assert.match(errorsFor({ "agent.md": "name: a\n", "env.md": ENV_MD })[0], /must start with YAML frontmatter/);
  assert.match(errorsFor({ "agent.md": "---\nname: a\n", "env.md": ENV_MD })[0], /not closed/);
  assert.match(errorsFor({ "agent.md": "---\nname: [a\n---\n", "env.md": ENV_MD })[0], /agent\.md:\d+: invalid YAML/);
});

test("agent.md needs name and model, and no system key", () => {
  const errors = errorsFor({ "agent.md": "---\nsystem: hi\n---\n", "env.md": ENV_MD });
  assert.ok(errors.some((e) => e.includes("`name` is required")));
  assert.ok(errors.some((e) => e.includes("`model` is required")));
  assert.ok(errors.some((e) => e.includes("`system` is not allowed")));
});

test("model may be an object with an id", () => {
  const agent = "---\nname: a\nmodel: {id: claude-opus-5-5, effort: high}\n---\n";
  assert.deepEqual(errorsFor({ "agent.md": agent, "env.md": ENV_MD }), []);
});

test("env.md config types are checked", () => {
  const env = "---\nname: e\nconfig:\n  type: docker\n  networking: {type: open}\n---\n";
  const errors = errorsFor({ "agent.md": AGENT_MD, "env.md": env });
  assert.ok(errors.some((e) => e.includes("`config.type`")));
  assert.ok(errors.some((e) => e.includes("`config.networking.type`")));
});

test("secrets are rejected", () => {
  const agent = AGENT_MD.replace("assistant.", "assistant. Use sk-ant-api03-abcdefghijklmnop.");
  assert.match(errorsFor({ "agent.md": agent, "env.md": ENV_MD })[0], /Anthropic API key/);
});

test("unknown fields are warnings, not errors", () => {
  const agent = AGENT_MD.replace("model:", "colour: blue\nmodel:");
  const { errors, warnings } = check(instance({ "agent.md": agent, "env.md": ENV_MD }));
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /unknown field `colour`/);
});
