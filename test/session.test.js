import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { chat } from "../src/chat.js";
import { deploy } from "../src/deploy.js";
import { Conversation, SessionError, openSession } from "../src/session.js";
import { AGENT_MD, instance } from "./helpers.js";

let n = 0;
const id = () => `sevt_${++n}`;
const message = (text) => ({ id: id(), type: "agent.message", content: [{ type: "text", text }] });
const idle = (type = "end_turn") => ({ id: id(), type: "session.status_idle", stop_reason: { type } });

// A fake sessions API. `script(event, emit)` is called for every event the client sends,
// and emits the events the agent would stream back.
function fakeSessions(script) {
  const sent = [];
  const history = [];
  let listeners = [];
  let dropNext = false;

  const emit = (event) => {
    history.push(event);
    for (const l of listeners) l.push(event);
  };

  const stream = async () => {
    const queue = [];
    let wake;
    const listener = { push: (e) => { queue.push(e); wake?.(); } };
    listeners.push(listener);
    async function* iterate() {
      while (true) {
        if (queue.length === 0) await new Promise((r) => (wake = r));
        const event = queue.shift();
        if (dropNext && event.type === "agent.message") {
          // Simulate a dropped connection: the event is in the history but this stream dies.
          dropNext = false;
          listeners = listeners.filter((l) => l !== listener);
          throw new Error("socket hang up");
        }
        yield event;
      }
    }
    const it = iterate();
    it.controller = { abort() {} };
    return it;
  };

  return {
    sent,
    history,
    dropNextMessage: () => (dropNext = true),
    client: {
      beta: {
        sessions: {
          create: async (params) => ({ id: "sesn_1", status: "idle", agent: { name: "Coding Assistant" }, params }),
          retrieve: async (sid) => ({ id: sid, status: "idle", agent: { name: "Coding Assistant" } }),
          events: {
            stream,
            list: async function* () { yield* history; },
            send: async (sid, { events }) => {
              for (const e of events) {
                sent.push(e);
                // Run the script after send() resolves, the way the real stream lags the request.
                setImmediate(() => script(e, emit));
              }
              return {};
            },
          },
        },
      },
    },
  };
}

const quietUI = (overrides = {}) => ({
  shown: [],
  event(e) { this.shown.push(e.type); },
  confirm: async () => ({ result: "allow" }),
  customToolResult: async () => "42",
  ...overrides,
});

test("a message turn streams the reply and ends at idle", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") {
      emit(message(`echo: ${e.content[0].text}`));
      emit(idle());
    }
  });
  const ui = quietUI();
  const outcome = await new Conversation(api.client, "sesn_1", ui).send("hi");
  assert.equal(outcome, "end_turn");
  assert.deepEqual(ui.shown, ["agent.message", "session.status_idle"]);
});

test("a paused tool call is confirmed, and the turn continues", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") {
      emit({ id: "sevt_tool", type: "agent.tool_use", name: "bash", input: { command: "rm -rf build" }, evaluated_permission: "ask" });
      emit(idle("requires_action"));
    }
    if (e.type === "user.tool_confirmation") {
      emit(message(e.result === "deny" ? `denied: ${e.deny_message}` : "ran it"));
      emit(idle());
    }
  });
  const ui = quietUI({ confirm: async () => ({ result: "deny", deny_message: "not that" }) });
  assert.equal(await new Conversation(api.client, "sesn_1", ui).send("clean up"), "end_turn");
  assert.deepEqual(api.sent[1], { type: "user.tool_confirmation", tool_use_id: "sevt_tool", result: "deny", deny_message: "not that" });
});

test("a custom tool call gets the result the user types", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") {
      emit({ id: "sevt_custom", type: "agent.custom_tool_use", name: "get_owner", input: { path: "a.py" } });
      emit(idle("requires_action"));
    }
    if (e.type === "user.custom_tool_result") emit(idle());
  });
  await new Conversation(api.client, "sesn_1", quietUI()).send("who owns a.py?");
  assert.deepEqual(api.sent[1], {
    type: "user.custom_tool_result",
    custom_tool_use_id: "sevt_custom",
    content: [{ type: "text", text: "42" }],
  });
});

test("a dropped stream reconnects without losing or repeating events", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") {
      emit(message("first"));
      emit(message("second"));
      emit(idle());
    }
  });
  api.dropNextMessage();
  const ui = quietUI();
  assert.equal(await new Conversation(api.client, "sesn_1", ui).send("go"), "end_turn");
  assert.deepEqual(ui.shown, ["agent.message", "agent.message", "session.status_idle"]);
});

test("a terminated session ends the turn", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") emit({ id: id(), type: "session.status_terminated" });
  });
  assert.equal(await new Conversation(api.client, "sesn_1", quietUI()).send("bye"), "terminated");
});

test("openSession pins the deployed agent version and warns about undeployed edits", async () => {
  const dir = instance();
  await deploy(dir, { client: deployClient() });
  writeFileSync(join(dir, "agent.md"), AGENT_MD.replace("helpful", "careful"));

  const api = fakeSessions(() => {});
  const { session, notes } = await openSession(dir, { client: api.client });
  assert.deepEqual(session.params, {
    agent: { type: "agent", id: "agent_2", version: 1 },
    environment_id: "env_1",
    title: "Coding Assistant (agentschema run)",
  });
  assert.match(notes[0], /agent\.md has changed since the last deploy/);
});

test("openSession needs a deploy first", async () => {
  await assert.rejects(openSession(instance(), { client: fakeSessions(() => {}).client }), SessionError);
});

test("chat reads lines, prints replies, and quits at end of input", async () => {
  const api = fakeSessions((e, emit) => {
    if (e.type === "user.message") {
      emit({ id: id(), type: "agent.tool_use", name: "bash", input: { command: "ls" }, evaluated_permission: "ask" });
      emit(idle("requires_action"));
    }
    if (e.type === "user.tool_confirmation") {
      emit(message(`tool ${e.result}`));
      emit(idle());
    }
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (d) => (printed += d));
  input.end("list files\ny\n");

  await chat(api.client, { id: "sesn_1" }, { agentName: "Coding Assistant", input, output });
  assert.match(printed, /· bash ls/);
  assert.match(printed, /Allow bash\?/);
  assert.match(printed, /tool allow/);
  assert.match(printed, /agentschema run --session sesn_1/);
});

function deployClient() {
  let k = 0;
  const resource = (kind) => ({
    create: async (body) => ({ id: `${kind}_${++k}`, version: 1, ...body }),
  });
  return { baseURL: "https://api.anthropic.com", beta: { agents: resource("agent"), environments: resource("env") } };
}
