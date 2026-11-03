import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { DeployError, deploy } from "../src/deploy.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

// Records calls and keeps resources in memory, in place of the real API client.
function fakeClient() {
  const calls = [];
  const store = new Map();
  let n = 0;
  const resource = (kind) => ({
    create: async (body) => {
      calls.push([`${kind}.create`, body]);
      const obj = { id: `${kind}_${++n}`, version: 1, metadata: body.metadata ?? {}, ...body };
      store.set(obj.id, obj);
      return obj;
    },
    retrieve: async (id) => {
      calls.push([`${kind}.retrieve`, id]);
      if (!store.has(id)) throw new Anthropic.NotFoundError(404, {}, "not found", new Headers());
      return store.get(id);
    },
    update: async (id, body) => {
      calls.push([`${kind}.update`, id, body]);
      const obj = store.get(id);
      if (body.version !== undefined && body.version !== obj.version) {
        throw new Anthropic.ConflictError(409, {}, "version conflict", new Headers());
      }
      Object.assign(obj, body, { version: obj.version + 1 });
      return obj;
    },
  });
  return { baseURL: "https://api.anthropic.com", calls, store, beta: { agents: resource("agent"), environments: resource("env") } };
}

const readLock = (dir) => JSON.parse(readFileSync(join(dir, "claude-lock.json"), "utf8"));

test("first deploy creates both resources and writes the lock", async () => {
  const dir = instance();
  const client = fakeClient();
  await deploy(dir, { client });

  assert.deepEqual(client.calls.map((c) => c[0]), ["env.create", "agent.create"]);
  assert.equal(client.calls[1][1].system, "You are a helpful coding assistant.");
  const lock = readLock(dir);
  assert.equal(lock.origin.base_url, "https://api.anthropic.com");
  assert.equal(lock.resources["./env.md"].id, "env_1");
  assert.deepEqual(
    { ...lock.resources["./agent.md"], hash: undefined },
    { kind: "agent", id: "agent_2", version: "1", hash: undefined },
  );
});

test("a second deploy with no changes calls nothing", async () => {
  const dir = instance();
  const client = fakeClient();
  await deploy(dir, { client });
  client.calls.length = 0;

  const plan = await deploy(dir, { client });
  assert.deepEqual(client.calls, []);
  assert.deepEqual(plan.map((p) => p.action), ["unchanged", "unchanged"]);
});

test("a changed agent.md updates the agent in place with the locked version", async () => {
  const dir = instance();
  const client = fakeClient();
  await deploy(dir, { client });
  writeFileSync(join(dir, "agent.md"), AGENT_MD.replace("helpful", "careful"));
  client.calls.length = 0;

  await deploy(dir, { client });
  const [, id, body] = client.calls.find((c) => c[0] === "agent.update");
  assert.equal(id, "agent_2");
  assert.equal(body.version, 1);
  assert.equal(body.system, "You are a careful coding assistant.");
  assert.equal(readLock(dir).resources["./agent.md"].version, "2");
  assert.equal(client.calls.some((c) => c[0] === "env.update"), false);
});

test("fields removed from the file are cleared on update", async () => {
  const dir = instance({
    "agent.md": "---\nname: a\nmodel: m\ndescription: d\nmetadata: {team: x}\n---\nPrompt\n",
    "env.md": ENV_MD,
  });
  const client = fakeClient();
  await deploy(dir, { client });
  writeFileSync(join(dir, "agent.md"), "---\nname: a\nmodel: m\n---\n");

  await deploy(dir, { client });
  const [, , body] = client.calls.find((c) => c[0] === "agent.update");
  assert.equal(body.system, null);
  assert.equal(body.description, null);
  assert.deepEqual(body.tools, []);
  assert.deepEqual(body.metadata, { team: null });
});

test("an agent changed elsewhere is not overwritten without --force", async () => {
  const dir = instance();
  const client = fakeClient();
  await deploy(dir, { client });
  client.store.get("agent_2").version = 5;
  writeFileSync(join(dir, "agent.md"), AGENT_MD.replace("helpful", "careful"));

  await assert.rejects(deploy(dir, { client }), /changed outside this folder.*version 1.*version 5/);
  await deploy(dir, { client, force: true });
  assert.equal(readLock(dir).resources["./agent.md"].version, "6");
});

test("--dry-run reports the plan and changes nothing", async () => {
  const dir = instance();
  const client = fakeClient();
  const plan = await deploy(dir, { client, dryRun: true });
  assert.deepEqual(plan.map((p) => p.action), ["create", "create"]);
  assert.deepEqual(client.calls, []);
  assert.throws(() => readLock(dir));
});

test("an invalid folder is not deployed", async () => {
  const client = fakeClient();
  await assert.rejects(deploy(instance({ "agent.md": AGENT_MD }), { client }), DeployError);
  assert.deepEqual(client.calls, []);
});

test("a lock for another API host is refused", async () => {
  const dir = instance();
  writeFileSync(join(dir, "claude-lock.json"), JSON.stringify({ version: 1, origin: { base_url: "https://other" }, resources: {} }));
  await assert.rejects(deploy(dir, { client: fakeClient() }), /written for https:\/\/other/);
});

test("a locked resource that no longer exists gives a clear error", async () => {
  const dir = instance();
  const client = fakeClient();
  await deploy(dir, { client });
  client.store.delete("env_1");
  writeFileSync(join(dir, "env.md"), ENV_MD.replace("quickstart", "renamed"));
  await assert.rejects(deploy(dir, { client }), /env_1 in claude-lock\.json no longer exists/);
});
