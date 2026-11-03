import assert from "node:assert/strict";
import { test } from "node:test";
import { listAgents, listSessions } from "../src/list.js";

const pages = (items) => ({ async *[Symbol.asyncIterator]() { yield* items; } });
const client = ({ agents = [], sessions = [] }) => ({
  beta: { agents: { list: () => pages(agents) }, sessions: { list: () => pages(sessions) } },
});

test("list shows each agent's name, id, version and model in aligned columns", async () => {
  const lines = await listAgents(client({
    agents: [
      { id: "agent_1", name: "Coding Assistant", version: 3, model: { id: "claude-opus-5-5" }, updated_at: "2026-11-03T10:00:00Z" },
      { id: "agent_22", name: "Calendar", version: 1, model: { id: "claude-haiku-5-5" }, updated_at: "2026-11-02T09:30:00Z" },
    ],
  }));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^NAME\s+ID\s+VERSION\s+MODEL\s+UPDATED$/);
  assert.match(lines[1], /^Coding Assistant\s+agent_1\s+3\s+claude-opus-5-5\s+2026-11-0\d \d\d:\d\d$/);
  assert.equal(lines[1].indexOf("agent_1"), lines[2].indexOf("agent_22"));
});

test("sessions list shows status, agent and title", async () => {
  const lines = await listSessions(client({
    sessions: [
      { id: "sesn_1", status: "idle", agent: { name: "Calendar", version: 2 }, title: null, created_at: "2026-11-03T10:00:00Z" },
      { id: "sesn_2", status: "terminated", agent: { name: "Coding Assistant", version: 1 }, title: "x".repeat(60), created_at: "2026-11-01T10:00:00Z" },
    ],
  }));
  assert.match(lines[0], /^ID\s+STATUS\s+AGENT\s+TITLE\s+CREATED$/);
  assert.match(lines[1], /^sesn_1\s+idle\s+Calendar v2\s+2026-/);
  assert.match(lines[2], /x{39}…/);
});

test("empty lists say so", async () => {
  assert.deepEqual(await listAgents(client({})), ["No agents."]);
  assert.deepEqual(await listSessions(client({})), ["No sessions."]);
});
