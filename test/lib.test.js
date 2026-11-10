import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as lib from "@soft-boy/agentschema";
import * as nodeApi from "@soft-boy/agentschema/node";
import { AGENT_MD, ENV_MD, PREBUILT_MD, instance, toolset } from "./helpers.js";

const { agentBody, agentbookTools, checkFiles, editFrontmatter, scaffold, defaultAnswers, skillRefs, textStream } = lib;
const { DeployError, check, deploy, deployFiles, hashBody, readFolder, skillFingerprint, startSession } = nodeApi;

const BASE = { "agent.md": AGENT_MD, "computer.md": ENV_MD };
const CATALOG = {
  google_calendar: {
    tools: [
      { name: "check_availability", description: "Find busy times.", input_schema: { type: "object", properties: {} } },
      { name: "create_booking", description: "Book a time.", input_schema: { type: "object", properties: {} } },
      { name: "delete_event", description: "Delete an event.", input_schema: { type: "object", properties: {} } },
    ],
  },
};
const CALENDAR_MD = `---
type: agentbook
toolset: google_calendar
---

## Tools

| Name | Enabled | Permission |
|---|---|---|
| \`create_booking\` | \`true\` | \`always_allow\` |
| \`check_availability\` | \`true\` | |
| \`delete_event\` | \`false\` | |
`;

// In-memory agents, environments and skills APIs that record what they're sent.
function fakeClient() {
  const calls = [];
  let n = 0;
  const resource = (kind) => ({
    create: async (body) => {
      calls.push([`${kind}.create`, body]);
      return { id: `${kind}_${++n}`, version: 1, ...body };
    },
    retrieve: async (id) => ({ id, version: 1, metadata: {} }),
    update: async (id, body) => {
      calls.push([`${kind}.update`, id, body]);
      return { id, version: 2, ...body };
    },
  });
  return {
    baseURL: "https://api.anthropic.com",
    calls,
    skills: {
      create: async ({ files }) => {
        calls.push(["skill.create", files.map((f) => f.name)]);
        return { id: `skill_${++n}`, latest_version_id: `skver_${++n}` };
      },
    },
    beta: {
      agents: resource("agent"),
      environments: resource("env"),
      sessions: { create: async (params) => ({ id: "sesn_1", ...params }) },
    },
  };
}

test("lib/ uses no Node APIs, and imports only yaml and itself", () => {
  const folder = fileURLToPath(new URL("../lib/", import.meta.url));
  for (const name of readdirSync(folder)) {
    const source = readFileSync(`${folder}${name}`, "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const path of imports) assert.ok(path === "yaml" || path.startsWith("./"), `${name} imports ${path}`);
    assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /\b(process\.|Buffer\.|require\()/, name);
  }
});

test("a file map checks and compiles the same as the folder it came from", () => {
  for (const example of ["calendar-agent", "coding-agent", "weather-agent"]) {
    const dir = fileURLToPath(new URL(`../examples/${example}`, import.meta.url));
    const fromFolder = check(dir);
    const fromMap = checkFiles(readFolder(dir));
    assert.deepEqual(fromMap.errors, fromFolder.errors);
    assert.deepEqual(fromMap.warnings, fromFolder.warnings);
    assert.deepEqual(agentBody(fromMap.instance), agentBody(fromFolder.instance));
  }
});

test("contents can be strings or bytes, and hash the same either way", () => {
  const skill = "---\nname: review\ndescription: Review code.\n---\n\nCafé ✓\n";
  const encoder = new TextEncoder();
  const asText = { ...BASE, "skills/review/SKILL.md": skill, "skills/review/logo.bin": new Uint8Array([0, 255, 1]) };
  const asBytes = Object.fromEntries(Object.entries(asText).map(([k, v]) => [k, typeof v === "string" ? encoder.encode(v) : v]));
  const a = checkFiles(asText);
  const b = checkFiles(asBytes);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(agentBody(a.instance), agentBody(b.instance));
  assert.equal(hashBody(skillFingerprint(a.instance.skills[0])), hashBody(skillFingerprint(b.instance.skills[0])));
});

test("a file map reports the same layout problems as a folder", () => {
  const errors = (files) => checkFiles(files).errors.join("\n");
  assert.match(errors({}), /agent\.md: missing[\s\S]*computer\.md: missing/);
  assert.match(errors({ "AGENT.md": AGENT_MD, "computer.md": ENV_MD }), /found AGENT\.md; the name must be lowercase/);
  assert.match(errors({ ...BASE, tools: "a file" }), /tools: not a directory/);
  assert.match(errors({ ...BASE, skills: "a file" }), /skills: not a directory/);
  assert.match(errors({ ...BASE, vaults: "a file" }), /vaults: not a directory/);
  assert.match(errors({ ...BASE, "vaults/Ops/sub/x.md": "---\n---\n" }), /vaults\/Ops\/sub: a vault holds credential files, not folders/);
  assert.equal(errors({ ...BASE, "tools/.drafts/x.md": "not valid", "tools/node_modules/y/README.md": "not valid", "tools/lib/helper.cjs": "1" }), "");
});

test("an agent's code never runs while it's being checked", () => {
  const marker = `globalThis.__agentschemaRan = true;`;
  const md = `---\ntype: custom\nname: t\ndescription: T.\n---\n\n## Code\n\n\`\`\`javascript\n${marker}\n}); ${marker} (function () {\n\`\`\`\n`;
  checkFiles({ ...BASE, "tools/t.md": md });
  assert.equal(globalThis.__agentschemaRan, undefined);
});

test("custom tools can be refused", () => {
  const md = "---\ntype: custom\nname: t\ndescription: T.\n---\n\n## Code\n\n```javascript\nmodule.exports = () => 1;\n```\n";
  assert.deepEqual(checkFiles({ ...BASE, "tools/t.md": md }).errors, []);
  const refused = checkFiles({ ...BASE, "tools/t.md": md }, { customTools: false }).errors.join("\n");
  assert.match(refused, /tools\/t\.md: custom tools aren't available here/);
});

test("agentbook tools compile to custom tools, and only the ones turned on", () => {
  const options = { toolsets: CATALOG, customTools: false };
  const { errors, warnings, instance: inst } = checkFiles({ ...BASE, "tools/google_calendar.md": CALENDAR_MD }, options);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(agentBody(inst, [], options).tools, [
    { type: "custom", name: "check_availability", description: "Find busy times.", input_schema: { type: "object", properties: {} } },
    { type: "custom", name: "create_booking", description: "Book a time.", input_schema: { type: "object", properties: {} } },
  ]);
  // A blank permission is the cautious one, since the API has no policy for these tools.
  assert.deepEqual(
    agentbookTools(inst.tools, CATALOG).map((t) => [t.name, t.permission, t.toolset]),
    [["check_availability", "always_ask", "google_calendar"], ["create_booking", "always_allow", "google_calendar"]],
  );
});

test("agentbook tool files are checked", () => {
  const errs = (md, file = "tools/google_calendar.md") => checkFiles({ ...BASE, [file]: md }, { toolsets: CATALOG }).errors.join("\n");
  assert.match(errs(CALENDAR_MD.replace("toolset: google_calendar\n", "")), /`toolset` is required/);
  assert.match(errs(CALENDAR_MD, "tools/calendar.md"), /`toolset` must match the file name \(calendar\)/);
  assert.match(errs(CALENDAR_MD.replaceAll("google_calendar", "gmail"), "tools/gmail.md"), /`gmail` isn't an agentbook toolset; use google_calendar/);
  assert.match(errs(CALENDAR_MD.replace("create_booking", "send_email")), /`send_email` is not a tool in `google_calendar`/);
  assert.match(errs(CALENDAR_MD.replace("`always_allow`", "`auto`")), /has permission `auto`; use always_allow, always_ask/);
  assert.match(errs(CALENDAR_MD.slice(0, CALENDAR_MD.indexOf("## Tools"))), /`## Tools` table listing the tools to enable is required/);
  assert.match(errs(CALENDAR_MD.replace("---\n\n", "extra: 1\n---\n\n")), /unknown field `extra`/);
  assert.match(errs("---\ntype: plugin\n---\n"), /`custom` or `agentbook`/);

  const custom = "---\ntype: custom\nname: create_booking\ndescription: T.\n---\n\n## Code\n\n```javascript\nmodule.exports = () => 1;\n```\n";
  const clash = checkFiles({ ...BASE, "tools/google_calendar.md": CALENDAR_MD, "tools/create_booking.md": custom }, { toolsets: CATALOG });
  assert.match(clash.errors.join("\n"), /another tool is already named `create_booking`/);
});

test("the CLI warns about agentbook tools at check, and refuses them at deploy", async () => {
  const dir = instance({ ...BASE, "tools/google_calendar.md": CALENDAR_MD });
  const { errors, warnings } = check(dir);
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /runs on agentbook, so `agentschema deploy` can't deploy it/);
  await assert.rejects(deploy(dir, { client: fakeClient() }), (err) => err instanceof DeployError && /can only be deployed from there/.test(err.message));
});

test("deployFiles works from a file map and a lock object, and touches no disk", async () => {
  const client = fakeClient();
  const saved = [];
  const files = { ...BASE, "tools/agent_toolset_20260401.md": PREBUILT_MD, "skills/review/SKILL.md": "---\nname: review\ndescription: Review code.\n---\n" };
  const first = await deployFiles({
    files,
    lock: null,
    client,
    // Async, like a database write; a snapshot, because the lock keeps changing.
    saveLock: async (lock) => { await null; saved.push(structuredClone(lock)); },
  });
  assert.deepEqual(first.plan.map((p) => [p.kind, p.action]), [["skill", "create"], ["environment", "create"], ["agent", "create"]]);
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.at(-1), first.lock);
  assert.deepEqual(client.calls.map((c) => c[0]), ["skill.create", "env.create", "agent.create"]);
  assert.deepEqual(client.calls[0][1], ["review/SKILL.md"]);
  assert.deepEqual(client.calls[2][1].skills, skillRefs(checkFiles(files).instance.skills, first.lock));

  // From a JSON round trip, the way it comes back from a database: nothing to do.
  client.calls.length = 0;
  const again = await deployFiles({ files: JSON.parse(JSON.stringify(files)), lock: JSON.parse(JSON.stringify(first.lock)), client });
  assert.deepEqual(client.calls, []);
  assert.deepEqual(again.plan.map((p) => p.action), ["unchanged", "unchanged", "unchanged"]);

  // A changed prompt updates only the agent; a dry run reports that without doing it.
  const edited = { ...files, "agent.md": AGENT_MD.replace("helpful", "careful") };
  const dry = await deployFiles({ files: edited, lock: first.lock, client, dryRun: true, saveLock: () => assert.fail("a dry run saves nothing") });
  assert.deepEqual(dry.plan.map((p) => p.action), ["unchanged", "unchanged", "update"]);
  assert.deepEqual(client.calls, []);
});

test("deployFiles compiles agentbook tools when given the catalog", async () => {
  const client = fakeClient();
  const checkOptions = { toolsets: CATALOG, customTools: false };
  await deployFiles({ files: { ...BASE, "tools/google_calendar.md": CALENDAR_MD }, client, checkOptions });
  const { tools } = client.calls.find((c) => c[0] === "agent.create")[1];
  assert.deepEqual(tools.map((t) => [t.type, t.name]), [["custom", "check_availability"], ["custom", "create_booking"]]);
  await assert.rejects(
    deployFiles({ files: { ...BASE, "tools/t.md": "---\ntype: custom\nname: t\ndescription: T.\n---\n" }, client, checkOptions }),
    /custom tools aren't available here/,
  );
});

test("startSession pins a version and passes a budget, from data alone", async () => {
  const client = fakeClient();
  const files = { ...BASE };
  const { lock } = await deployFiles({ files, client });
  const { instance: inst } = checkFiles(files);
  const budget = { type: "limit", max_list_cost: { amount: "1.00", currency: "USD" } };
  const { session } = await startSession({ instance: inst, lock, client, agentVersion: 7, budget, title: "Live chat" });
  assert.deepEqual(session.agent, { type: "agent", id: lock.resources["./agent.md"].id, version: 7 });
  assert.equal(session.environment_id, lock.resources["./computer.md"].id);
  assert.equal(session.title, "Live chat");
  assert.deepEqual(session.budget, budget);
  await assert.rejects(startSession({ instance: inst, lock: null, client }), /hasn't been deployed/);
});

test("env.md, computer.md's old name, still works, with a warning to rename it", () => {
  const old = { "agent.md": AGENT_MD, "env.md": ENV_MD };
  const { errors, warnings, instance: inst } = checkFiles(old);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ["env.md: this is computer.md's old name; rename it to computer.md"]);
  assert.equal(inst.env.file, "env.md");
  assert.equal(inst.env.data.name, "quickstart");
  // Its problems are reported under the name it has.
  assert.match(checkFiles({ ...old, "env.md": "---\ndescription: x\n---\n" }).errors.join("\n"), /^env\.md: `name` is required$/m);
  assert.ok("env.md" in readFolder(instance(old)));

  // Both is an error, and computer.md is the one used.
  const both = checkFiles({ ...old, "computer.md": ENV_MD.replace("quickstart", "new") });
  assert.deepEqual(both.errors, ["env.md: this is computer.md's old name, and the folder has both; remove env.md"]);
  assert.equal(both.instance.env.file, "computer.md");
  assert.equal(both.instance.env.data.name, "new");
});

test("a lock from before the rename keeps its environment, moved to ./computer.md on the next deploy", async () => {
  const client = fakeClient();
  const { lock } = await deployFiles({ files: BASE, client });
  const { "./computer.md": environment, ...rest } = lock.resources;
  const oldLock = () => ({ ...structuredClone(lock), resources: { "./env.md": structuredClone(environment), ...structuredClone(rest) } });

  // A session starts from it as it is.
  const { session } = await startSession({ instance: checkFiles(BASE).instance, lock: oldLock(), client });
  assert.equal(session.environment_id, environment.id);

  // Deploying, from either name, updates that environment rather than making another.
  for (const files of [BASE, { "agent.md": AGENT_MD, "env.md": ENV_MD }]) {
    client.calls.length = 0;
    const unchanged = await deployFiles({ files, lock: oldLock(), client });
    assert.deepEqual(client.calls, []);
    assert.deepEqual(unchanged.plan.map((p) => [p.kind, p.action, p.id]), [["environment", "unchanged", environment.id], ["agent", "unchanged", lock.resources["./agent.md"].id]]);
    assert.deepEqual(unchanged.lock.resources["./computer.md"], environment);
    assert.equal("./env.md" in unchanged.lock.resources, false);

    const renamed = { ...files };
    for (const name of ["computer.md", "env.md"]) if (renamed[name]) renamed[name] = ENV_MD.replace("quickstart", "renamed");
    const updated = await deployFiles({ files: renamed, lock: oldLock(), client });
    assert.deepEqual(client.calls.map((c) => [c[0], c[1]]), [["env.update", environment.id]]);
    assert.equal(updated.lock.resources["./computer.md"].id, environment.id);
    assert.equal("./env.md" in updated.lock.resources, false);
  }
});

test("scaffold and editFrontmatter work on text alone", () => {
  const files = scaffold(defaultAnswers("Bug Triage"));
  assert.deepEqual(Object.keys(files), ["agent.md", "computer.md", "tools/agent_toolset_20260401.md"]);
  assert.deepEqual(checkFiles(files).errors, []);
  assert.equal(checkFiles(files).instance.agent.data.name, "Bug Triage");

  const edited = editFrontmatter("---\nname: A # keep\n---\n\nBody.\n", (doc) => doc.set("model", "m"));
  assert.equal(edited, "---\nname: A # keep\nmodel: m\n---\n\nBody.\n");
});

test("textStream is available from the core", () => {
  const out = [];
  const s = textStream((t) => out.push(t));
  s.handle({ type: "event_start", event: { type: "agent.message", id: "a" } });
  s.handle({ type: "event_delta", event_id: "a", delta: { content: { type: "text", text: "Hi" } } });
  s.handle({ id: "a", type: "agent.message", content: [{ type: "text", text: "Hi there" }] });
  assert.deepEqual(out, ["Hi", " there\n"]);
});
