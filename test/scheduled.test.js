import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { checkFiles } from "../lib/check.js";
import { cronProblem, readScheduled, taskBody, taskSettings } from "../lib/scheduled.js";
import { archiveScheduled, deployFiles, pauseScheduled } from "../src/deploy.js";
import { readFolder } from "../src/folder.js";
import { AGENT_MD, ENV_MD, instance, toolset } from "./helpers.js";

const BASE = { "agent.md": AGENT_MD, "computer.md": ENV_MD };
const task = (front, body = "Say good morning in #gm.") => `---\n${front}\n---\n\n${body}\n`;
const MORNING = task('schedule: "0 8 * * 1-5"\ntimezone: America/Los_Angeles');
const checked = (files) => checkFiles({ ...BASE, ...files });
const errorsFor = (front, body) => checked({ "scheduled/good-morning.md": task(front, body) }).errors;
const VALID = 'schedule: "0 8 * * 1-5"\ntimezone: America/Los_Angeles';

test("a task is valid, and reaches the check's instance", () => {
  const { errors, warnings, instance: checkedInstance } = checked({ "scheduled/good-morning.md": MORNING });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(checkedInstance.scheduled[0].name, "good-morning");
  assert.equal(checkedInstance.scheduled[0].body, "Say good morning in #gm.");
});

test("an agent doesn't need any tasks, and scheduled/ is a flat folder of .md files", () => {
  assert.deepEqual(checked({}).instance.scheduled, []);
  assert.match(checked({ scheduled: "x" }).errors[0], /scheduled: not a directory/);
  assert.match(checked({ "scheduled/morning/a.md": MORNING }).errors[0], /scheduled\/morning: scheduled\/ holds task files, not folders/);
  assert.deepEqual(readScheduled({ "scheduled/notes.txt": "hi" }).tasks, []);
});

test("a task's name has to work as a deployment's name", () => {
  assert.match(checked({ "scheduled/Good Morning.md": MORNING }).errors[0], /the name may only use lowercase letters/);
});

test("the schedule and time zone are required, and checked", () => {
  assert.match(errorsFor('timezone: UTC')[0], /`schedule` is required/);
  assert.match(errorsFor('schedule: "0 8 * * *"')[0], /`timezone` is required/);
  assert.match(errorsFor('schedule: "0 8 * * *"\ntimezone: Mars/Olympus')[0], /`timezone` must be a time zone/);
  assert.deepEqual(errorsFor('schedule: "*/15 9-17 * * 1-5"\ntimezone: UTC'), []);
  assert.match(errorsFor("schedule: 8\ntimezone: UTC")[0], /in quotes/);
});

test("cron expressions use the standard five parts", () => {
  for (const good of ["0 8 * * *", "*/5 * * * *", "0 9 1,15 * *", "30 6 * 1-6/2 0,6", "0 0 * * 7", "5/10 * * * *"]) assert.equal(cronProblem(good), null, good);
  assert.match(cronProblem("0 8 * *"), /five parts/);
  assert.match(cronProblem("0 8 * * * 2026"), /five parts/);
  assert.match(cronProblem("60 8 * * *"), /"60" for the minute, which goes from 0 to 59/);
  assert.match(cronProblem("0 8 0 * *"), /day of the month, which goes from 1 to 31/);
  assert.match(cronProblem("0 8 * * MON"), /"MON" for the day of the week; use numbers/);
  assert.match(cronProblem("0 17-9 * * *"), /runs backwards/);
  assert.match(cronProblem("*/0 * * * *"), /at least 1/);
  assert.match(cronProblem("@daily"), /five parts/);
});

test("the other fields are checked, and nothing else is allowed", () => {
  assert.deepEqual(errorsFor(`${VALID}\nenabled: false\nbudget: 0.5\ndescription: Says hello.`), []);
  assert.match(errorsFor(`${VALID}\nenabled: "no"`)[0], /`enabled` must be true or false/);
  for (const budget of ["0", "-1", "0.001", '"5"']) assert.match(errorsFor(`${VALID}\nbudget: ${budget}`)[0], /`budget` must be an amount in US dollars/, budget);
  assert.match(errorsFor(`${VALID}\ndescription: 5`)[0], /`description` must be text/);
  assert.match(errorsFor(`${VALID}\ncron: "0 8 * * *"`)[0], /unknown field `cron`/);
  assert.match(errorsFor(VALID, "")[0], /the body is empty; it's the message the agent starts each run with/);
});

test("secrets can't hide in a task", () => {
  assert.match(errorsFor(VALID, `Use the key sk-ant-${"a".repeat(20)} to post.`)[0], /scheduled\/good-morning\.md: looks like it contains an Anthropic API key/);
});

test("tools that wait for someone get a warning, since nobody answers during a scheduled run", () => {
  const custom = "---\ntype: custom\nname: get_weather\ndescription: Weather.\n---\n\n## Code\n\n```js\nmodule.exports = () => 'sunny';\n```\n";
  const files = { "scheduled/good-morning.md": MORNING, "tools/agent_toolset_20260401.md": toolset("bash | true | always_ask", "read | true | always_allow"), "tools/get_weather.md": custom };
  const { warnings } = checked(files);
  assert.deepEqual(warnings, ["scheduled/good-morning.md: nobody's there to answer during a scheduled run, so a run that calls one of these waits until it's stopped: bash, get_weather"]);
  assert.deepEqual(checked({ ...files, "scheduled/good-morning.md": task(`${VALID}\nenabled: false`) }).warnings, []);
  assert.deepEqual(checked({ "scheduled/good-morning.md": MORNING, "tools/agent_toolset_20260401.md": toolset("read | true | always_allow") }).warnings, []);
});

test("a task becomes the parts of a deployment that come from its file", () => {
  const [parsed] = readScheduled({ "scheduled/good-morning.md": task(`${VALID}\nbudget: 0.5\ndescription: Says hello.`) }).tasks;
  assert.deepEqual(taskBody(parsed), {
    name: "good-morning",
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "Say good morning in #gm." }] }],
    schedule: { type: "cron", expression: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
    budget: { type: "limit", max_list_cost: { amount: "50", currency: "USD" } },
    description: "Says hello.",
  });
  assert.deepEqual(taskSettings(parsed), { name: "good-morning", schedule: "0 8 * * 1-5", timezone: "America/Los_Angeles", enabled: true, budgetCents: 50, description: "Says hello.", message: "Say good morning in #gm." });
  assert.equal(taskSettings(readScheduled({ "scheduled/x.md": task(`${VALID}\nbudget: 0.07`) }).tasks[0]).budgetCents, 7);
});

test("reading a folder from disk includes scheduled/", () => {
  const dir = instance({ ...BASE, "scheduled/good-morning.md": MORNING });
  assert.ok("scheduled/good-morning.md" in readFolder(dir));
});

// Keeps resources in memory in place of the API, with deployments that can be paused and archived.
function fakeClient() {
  const calls = [];
  const store = new Map();
  let n = 0;
  const notFound = () => new Anthropic.NotFoundError(404, {}, "not found", new Headers());
  const resource = (kind, extra = {}) => ({
    create: async (body) => {
      calls.push([`${kind}.create`, body]);
      const obj = { id: `${kind}_${++n}`, version: 1, metadata: {}, archived_at: null, ...extra, ...body };
      if (kind === "depl") obj.schedule = { ...body.schedule, upcoming_runs_at: ["2026-11-09T16:00:00Z"] };
      store.set(obj.id, obj);
      return obj;
    },
    retrieve: async (id) => {
      calls.push([`${kind}.retrieve`, id]);
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
  const status = (verb, change) => async (id) => {
    calls.push([`depl.${verb}`, id]);
    const obj = store.get(id);
    if (!obj) throw notFound();
    Object.assign(obj, change());
    return obj;
  };
  return {
    baseURL: "https://api.anthropic.com",
    calls,
    store,
    beta: {
      agents: resource("agent"),
      environments: resource("env"),
      vaults: resource("vault"),
      deployments: {
        ...resource("depl", { status: "active" }),
        pause: status("pause", () => ({ status: "paused", paused_reason: { type: "manual" } })),
        unpause: status("unpause", () => ({ status: "active", paused_reason: null })),
        archive: status("archive", () => ({ archived_at: "2026-11-07T00:00:00Z" })),
      },
    },
  };
}

const deployed = async (files, client, lock = null, options = {}) => {
  const log = [];
  const result = await deployFiles({ files: { ...BASE, ...files }, lock, client, log: (line) => log.push(line), ...options });
  return { ...result, log };
};
const deploymentCalls = (client) => client.calls.filter(([name]) => name.startsWith("depl.")).map(([name]) => name);

test("deploying makes a deployment, pinned to the agent's version, with its environment and vaults", async () => {
  const client = fakeClient();
  const vault = { "vaults/secrets/linear.md": "---\nauth:\n  type: mcp_oauth\n  mcp_server_url: https://mcp.linear.app/mcp\n---\n" };
  const { lock, plan, log } = await deployed({ "scheduled/good-morning.md": MORNING, ...vault }, client);
  const [, body] = client.calls.find(([name]) => name === "depl.create");
  assert.deepEqual(body, {
    name: "good-morning",
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "Say good morning in #gm." }] }],
    schedule: { type: "cron", expression: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
    agent: { type: "agent", id: lock.resources["./agent.md"].id, version: 1 },
    environment_id: lock.resources["./computer.md"].id,
    vault_ids: [lock.resources["./vaults/secrets"].id],
  });
  const entry = lock.resources["./scheduled/good-morning.md"];
  assert.equal(entry.kind, "deployment");
  assert.equal(entry.paused, false);
  assert.deepEqual(plan.at(-1), { file: "scheduled/good-morning.md", kind: "deployment", action: "create", id: entry.id, version: undefined });
  assert.ok(log.includes(`created   deployment ${entry.id} (next run 2026-11-09T16:00:00Z)`));

  // Nothing changed, so nothing is sent.
  const before = client.calls.length;
  await deployed({ "scheduled/good-morning.md": MORNING, ...vault }, client, lock);
  assert.equal(client.calls.length, before);
});

test("a change to the task, or to the agent, updates the deployment", async () => {
  const client = fakeClient();
  const { lock } = await deployed({ "scheduled/good-morning.md": MORNING }, client);
  const id = lock.resources["./scheduled/good-morning.md"].id;

  await deployed({ "scheduled/good-morning.md": task(`${VALID}\nbudget: 1`, "Say hi in #gm.") }, client, lock);
  assert.equal(client.store.get(id).initial_events[0].content[0].text, "Say hi in #gm.");
  assert.deepEqual(client.store.get(id).budget, { type: "limit", max_list_cost: { amount: "100", currency: "USD" } });

  // Taking the budget out of the file clears it, rather than leaving it.
  await deployed({ "scheduled/good-morning.md": MORNING }, client, lock);
  assert.equal(client.store.get(id).budget, null);
  assert.equal(client.store.get(id).description, null);

  await deployed({ "agent.md": AGENT_MD.replace("helpful", "cheerful"), "scheduled/good-morning.md": MORNING }, client, lock);
  assert.deepEqual(client.store.get(id).agent, { type: "agent", id: lock.resources["./agent.md"].id, version: 2 });
});

test("turning a task off pauses it, and turning it on again unpauses it", async () => {
  const client = fakeClient();
  const off = task(`${VALID}\nenabled: false`);
  const { lock, log } = await deployed({ "scheduled/good-morning.md": off }, client);
  const id = lock.resources["./scheduled/good-morning.md"].id;
  assert.equal(client.store.get(id).status, "paused");
  assert.ok(log.includes(`created   deployment ${id} (paused)`));

  const { plan, log: again } = await deployed({ "scheduled/good-morning.md": MORNING }, client, lock);
  assert.equal(plan.at(-1).action, "unpause");
  assert.equal(client.store.get(id).status, "active");
  assert.deepEqual(deploymentCalls(client).slice(-2), ["depl.retrieve", "depl.unpause"]);
  assert.ok(again.includes(`unpaused  deployment ${id} (next run 2026-11-09T16:00:00Z)`));
});

test("removing a task's file archives its deployment, so it stops running", async () => {
  const client = fakeClient();
  const { lock } = await deployed({ "scheduled/good-morning.md": MORNING, "scheduled/weekly.md": task('schedule: "0 9 * * 1"\ntimezone: UTC', "Plan the week.") }, client);
  const id = lock.resources["./scheduled/good-morning.md"].id;

  const dry = await deployed({ "scheduled/weekly.md": task('schedule: "0 9 * * 1"\ntimezone: UTC', "Plan the week.") }, client, structuredClone(lock), { dryRun: true });
  assert.deepEqual(dry.plan.at(-1), { file: "scheduled/good-morning.md", kind: "deployment", action: "archive", id, version: undefined });
  assert.equal(client.store.get(id).archived_at, null);

  const { log } = await deployed({ "scheduled/weekly.md": task('schedule: "0 9 * * 1"\ntimezone: UTC', "Plan the week.") }, client, lock);
  assert.ok(client.store.get(id).archived_at);
  assert.equal(lock.resources["./scheduled/good-morning.md"], undefined);
  assert.ok(log.includes(`archived  deployment ${id} (scheduled/good-morning.md is gone)`));
});

test("a deployment archived elsewhere is replaced with a new one", async () => {
  const client = fakeClient();
  const { lock } = await deployed({ "scheduled/good-morning.md": MORNING }, client);
  const old = lock.resources["./scheduled/good-morning.md"].id;
  client.store.get(old).archived_at = "2026-11-07T00:00:00Z";

  const { log } = await deployed({ "scheduled/good-morning.md": task(VALID, "Say hi.") }, client, lock);
  const fresh = lock.resources["./scheduled/good-morning.md"].id;
  assert.notEqual(fresh, old);
  assert.ok(log.includes(`replaced  deployment ${fresh} (${old} was archived) (next run 2026-11-09T16:00:00Z)`));
});

test("a dry run shows what would happen, without IDs it doesn't have yet", async () => {
  const client = fakeClient();
  const { plan, log } = await deployed({ "scheduled/good-morning.md": MORNING }, client, null, { dryRun: true });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(plan.at(-1), { file: "scheduled/good-morning.md", kind: "deployment", action: "create", id: undefined, version: undefined });
  assert.equal(log.at(-1), "create    deployment good-morning");
});

test("a host can leave tasks alone, pause them all, or archive them all", async () => {
  const client = fakeClient();
  const skipped = await deployed({ "scheduled/good-morning.md": MORNING }, client, null, { scheduled: false });
  assert.deepEqual(deploymentCalls(client), []);
  assert.equal(skipped.plan.some((step) => step.kind === "deployment"), false);

  const { lock } = await deployed({ "scheduled/good-morning.md": MORNING }, client);
  const id = lock.resources["./scheduled/good-morning.md"].id;
  const saved = [];
  await pauseScheduled({ lock, client, saveLock: (next) => saved.push(structuredClone(next)) });
  assert.equal(client.store.get(id).status, "paused");
  assert.equal(saved.at(-1).resources["./scheduled/good-morning.md"].paused, true);
  // Pausing again changes nothing.
  await pauseScheduled({ lock, client });
  assert.equal(deploymentCalls(client).filter((name) => name === "depl.pause").length, 1);

  // The next deploy turns it back on, since the file says it's enabled.
  await deployed({ "scheduled/good-morning.md": MORNING }, client, lock);
  assert.equal(client.store.get(id).status, "active");

  await archiveScheduled({ lock, client });
  assert.ok(client.store.get(id).archived_at);
  assert.equal(lock.resources["./scheduled/good-morning.md"], undefined);
});
