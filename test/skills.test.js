import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { check } from "../src/check.js";
import { deploy } from "../src/deploy.js";
import { openSession } from "../src/session.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

const SKILL_MD = "---\nname: code-review\ndescription: Review code for bugs. Use when asked to review a change.\n---\n\nRead `checklist.md` first.\n";
const folder = (files = {}) => instance({ "agent.md": AGENT_MD, "computer.md": ENV_MD, "skills/code-review/SKILL.md": SKILL_MD, ...files });
const lockOf = (dir) => JSON.parse(readFileSync(join(dir, "claude-lock.json"), "utf8"));

function fakeClient() {
  const calls = [];
  const store = new Map();
  let n = 0;
  const notFound = () => new Anthropic.NotFoundError(404, {}, "not found", new Headers());
  const resource = (kind) => ({
    create: async (body) => {
      calls.push([`${kind}.create`, body]);
      const obj = { id: `${kind}_${++n}`, version: 1, metadata: {}, ...body };
      store.set(obj.id, obj);
      return obj;
    },
    retrieve: async (id) => {
      if (!store.has(id)) throw notFound();
      return store.get(id);
    },
    update: async (id, body) => {
      calls.push([`${kind}.update`, id, body]);
      const obj = store.get(id);
      Object.assign(obj, body, { version: obj.version + 1 });
      return obj;
    },
  });
  const uploads = async ({ files }) => Promise.all(files.map(async (f) => [f.name, await f.text()]));
  return {
    baseURL: "https://api.anthropic.com",
    calls,
    store,
    skills: {
      create: async (params) => {
        const id = `skill_${++n}`;
        calls.push(["skill.create", await uploads(params)]);
        store.set(id, { id });
        return { id, latest_version_id: `skver_${++n}` };
      },
      retrieve: async (id) => {
        if (!store.has(id)) throw notFound();
        return store.get(id);
      },
      versions: {
        create: async (skillId, params) => {
          calls.push(["skill.version", skillId, await uploads(params)]);
          return { id: `skver_${++n}`, skill_id: skillId };
        },
      },
    },
    beta: {
      agents: resource("agent"),
      environments: resource("env"),
      sessions: { create: async (params) => ({ id: "sesn_1", ...params }) },
    },
  };
}

test("skills are checked", () => {
  const errs = (files) => check(instance({ "agent.md": AGENT_MD, "computer.md": ENV_MD, ...files })).errors.join("\n");
  const skill = (md) => ({ "skills/code-review/SKILL.md": md });
  assert.equal(errs(skill(SKILL_MD)), "");
  assert.match(errs({ "skills/code-review/notes.md": "x" }), /skills\/code-review: missing SKILL\.md/);
  assert.match(errs({ "skills/review.md": "x" }), /each skill is a folder/);
  assert.match(errs(skill("no frontmatter")), /must start with YAML frontmatter/);
  assert.match(errs(skill(SKILL_MD.replace("name: code-review\n", ""))), /`name` is required/);
  assert.match(errs(skill(SKILL_MD.replace("name: code-review", "name: reviewer"))), /must match the folder's name \(code-review\)/);
  assert.match(errs({ "skills/Code_Review/SKILL.md": SKILL_MD.replace("code-review", "Code_Review") }), /lowercase letters, digits and hyphens/);
  assert.match(errs({ "skills/claude-review/SKILL.md": SKILL_MD.replace("code-review", "claude-review") }), /reserved words/);
  assert.match(errs(skill(SKILL_MD.replace(/description: .*/, "description: Use <b>this</b>."))), /can't contain XML tags/);
  assert.match(errs(skill(SKILL_MD.replace(/description: .*/, `description: ${"x".repeat(1025)}`))), /the limit is 1,024/);
  assert.match(errs({ ...skill(SKILL_MD), "skills/code-review/ref/notes.md": "key: sk-ant-abcdefghijkl" }), /skills\/code-review\/ref\/notes\.md: looks like it contains an Anthropic API key/);
});

test("skills listed in agent.md must be in the API's shape", () => {
  const errs = (list) => check(instance({ "agent.md": AGENT_MD.replace("model: claude-opus-5-5\n", `model: claude-opus-5-5\nskills:\n${list}`), "computer.md": ENV_MD })).errors.join("\n");
  assert.equal(errs("  - type: anthropic\n    skill_id: xlsx\n  - type: custom\n    skill_id: skill_01Ab\n    version: latest\n"), "");
  assert.match(errs("  - ../skills/code-review\n"), /`skills\[0\]`: write this as a mapping.*attached without being listed/);
  assert.match(errs("  - type: plugin\n    skill_id: xlsx\n"), /`type` must be `anthropic` or `custom`/);
  assert.match(errs("  - type: anthropic\n"), /`skill_id` is required/);
  assert.match(errs("  - type: custom\n    skill_id: code-review\n"), /custom skill's `skill_id` starts with skill_/);
  assert.match(errs("  - type: anthropic\n    skill_id: xlsx\n    version: 20251013\n"), /`version` must be a string/);
});

test("deploy uploads a skill's files under its folder name, and pins the agent to its version", async () => {
  const dir = folder({ "skills/code-review/ref/checklist.md": "- bugs\n", "skills/code-review/.DS_Store": "junk", "skills/code-review/node_modules/x/index.js": "junk" });
  const client = fakeClient();
  const plan = await deploy(dir, { client });

  assert.deepEqual(client.calls[0], ["skill.create", [["code-review/SKILL.md", SKILL_MD], ["code-review/ref/checklist.md", "- bugs\n"]]]);
  const entry = lockOf(dir).resources["./skills/code-review"];
  assert.equal(entry.kind, "skill");
  assert.match(entry.id, /^skill_/);
  assert.match(entry.version, /^skver_/);
  assert.deepEqual(client.calls.find((c) => c[0] === "agent.create")[1].skills, [{ type: "custom", skill_id: entry.id, version: entry.version }]);
  assert.deepEqual(plan.map((p) => [p.kind, p.action]), [["skill", "create"], ["environment", "create"], ["agent", "create"]]);

  // The IDs only go in the lock, so SKILL.md is untouched.
  assert.equal(readFileSync(join(dir, "skills/code-review/SKILL.md"), "utf8"), SKILL_MD);

  client.calls.length = 0;
  await deploy(dir, { client });
  assert.deepEqual(client.calls, []);
});

test("changing any file uploads a new version and updates the agent to it", async () => {
  const dir = folder({ "skills/code-review/checklist.md": "- bugs\n" });
  const client = fakeClient();
  await deploy(dir, { client });
  const before = lockOf(dir).resources["./skills/code-review"];

  writeFileSync(join(dir, "skills/code-review/checklist.md"), "- bugs\n- tests\n");
  client.calls.length = 0;
  const dry = await deploy(dir, { client, dryRun: true });
  assert.deepEqual(client.calls, []);
  assert.deepEqual(dry.map((p) => p.action), ["update", "unchanged", "update"]);

  await deploy(dir, { client });
  const after = lockOf(dir).resources["./skills/code-review"];
  assert.equal(after.id, before.id);
  assert.notEqual(after.version, before.version);
  const [, skillId, files] = client.calls.find((c) => c[0] === "skill.version");
  assert.equal(skillId, before.id);
  assert.deepEqual(files.map((f) => f[0]), ["code-review/SKILL.md", "code-review/checklist.md"]);
  const update = client.calls.find((c) => c[0] === "agent.update")[2];
  assert.deepEqual(update.skills, [{ type: "custom", skill_id: before.id, version: after.version }]);
});

test("a first dry run shows what would be created, without creating it", async () => {
  const dir = folder();
  const client = fakeClient();
  const plan = await deploy(dir, { client, dryRun: true });
  assert.deepEqual(plan.map((p) => [p.kind, p.action]), [["skill", "create"], ["environment", "create"], ["agent", "create"]]);
  assert.deepEqual(client.calls, []);
});

test("skills in agent.md are kept, and the folder's are added", async () => {
  const agent = AGENT_MD.replace("model: claude-opus-5-5\n", "model: claude-opus-5-5\nskills:\n  - type: anthropic\n    skill_id: xlsx\n");
  const dir = instance({ "agent.md": agent, "computer.md": ENV_MD, "skills/code-review/SKILL.md": SKILL_MD });
  const client = fakeClient();
  await deploy(dir, { client });
  const { skills } = client.calls.find((c) => c[0] === "agent.create")[1];
  assert.deepEqual(skills[0], { type: "anthropic", skill_id: "xlsx" });
  assert.equal(skills[1].type, "custom");
  assert.equal(skills.length, 2);
});

test("removing a skill's folder detaches it from the agent", async () => {
  const dir = folder();
  const client = fakeClient();
  await deploy(dir, { client });
  rmSync(join(dir, "skills"), { recursive: true });
  client.calls.length = 0;
  await deploy(dir, { client });
  assert.deepEqual(client.calls.map((c) => c[0]), ["agent.update"]);
  assert.deepEqual(client.calls[0][2].skills, []);
});

test("a skill deleted outside the folder gives a clear error", async () => {
  const dir = folder();
  const client = fakeClient();
  await deploy(dir, { client });
  client.store.delete(lockOf(dir).resources["./skills/code-review"].id);
  writeFileSync(join(dir, "skills/code-review/SKILL.md"), `${SKILL_MD}More.\n`);
  await assert.rejects(deploy(dir, { client }), /skill .* no longer exists\. Remove the "\.\/skills\/code-review" entry/);
});

test("run warns about a skill changed since the last deploy, but not an unchanged one", async () => {
  const dir = folder();
  const client = fakeClient();
  await deploy(dir, { client });
  assert.deepEqual((await openSession(dir, { client })).notes, []);
  writeFileSync(join(dir, "skills/code-review/SKILL.md"), `${SKILL_MD}More.\n`);
  assert.match((await openSession(dir, { client })).notes.join("\n"), /skills\/code-review has changed since the last deploy/);
});

test("the real client sends each file's path to the API", async () => {
  let body = "";
  let url = "";
  const server = createServer(async (req, res) => {
    url = req.url;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "skill_1", latest_version_id: "skver_1" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const dir = folder({ "skills/code-review/ref/checklist.md": "- bugs\n" });
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
    const real = client.beta.environments;
    client.beta.environments = { create: async () => ({ id: "env_1" }), retrieve: real.retrieve };
    client.beta.agents = { create: async () => ({ id: "agent_1", version: 1 }) };
    await deploy(dir, { client });
    assert.equal(url.split("?")[0], "/v1/skills");
    assert.match(body, /name="files(\[\])?"; filename="code-review\/SKILL\.md"/);
    assert.match(body, /name="files(\[\])?"; filename="code-review\/ref\/checklist\.md"/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
