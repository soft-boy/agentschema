import assert from "node:assert/strict";
import { test } from "node:test";
import { DeleteError, deleteAgent, deleteSession } from "../src/delete.js";

function fakeClient({ agent = {}, session = {} } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      agents: {
        retrieve: async (id) => ({ id, name: "Calendar", archived_at: null, ...agent }),
        archive: async (id) => calls.push(["archive", id]),
      },
      sessions: {
        retrieve: async (id) => ({ id, status: "idle", title: "Bug triage", ...session }),
        delete: async (id) => calls.push(["delete", id]),
      },
    },
  };
}

const yes = async () => true;
const no = async () => false;
const quiet = () => {};

test("delete archives the agent after confirming, naming it in the question", async () => {
  const client = fakeClient();
  let asked;
  await deleteAgent(client, "agent_1", { confirm: async (q) => ((asked = q), true), log: quiet });
  assert.match(asked, /Archive agent "Calendar" \(agent_1\)\?/);
  assert.deepEqual(client.calls, [["archive", "agent_1"]]);
});

test("declining changes nothing", async () => {
  const client = fakeClient();
  await deleteAgent(client, "agent_1", { confirm: no, log: quiet });
  await deleteSession(client, "sesn_1", { confirm: no, log: quiet });
  assert.deepEqual(client.calls, []);
});

test("an agent that's already archived is an error", async () => {
  const client = fakeClient({ agent: { archived_at: "2026-11-01T00:00:00Z" } });
  await assert.rejects(deleteAgent(client, "agent_1", { confirm: yes, log: quiet }), DeleteError);
});

test("sessions delete removes an idle session", async () => {
  const client = fakeClient();
  await deleteSession(client, "sesn_1", { confirm: yes, log: quiet });
  assert.deepEqual(client.calls, [["delete", "sesn_1"]]);
});

test("a running session isn't deleted", async () => {
  const client = fakeClient({ session: { status: "running" } });
  await assert.rejects(deleteSession(client, "sesn_1", { confirm: yes, log: quiet }), /is running/);
  assert.deepEqual(client.calls, []);
});
