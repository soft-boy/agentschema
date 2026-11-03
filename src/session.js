import { check } from "./check.js";
import { AGENT_FILE, ENV_FILE, agentBody, envBody } from "./instance.js";
import { LOCK_FILE, hashBody, readLock } from "./lock.js";

export class SessionError extends Error {}

// Starts a session on the agent and environment recorded in claude-lock.json, or resumes `sessionId`.
// Returns { session, notes }: notes are warnings worth showing, such as files changed since the last deploy.
export async function openSession(dir, { client, sessionId, vaultIds = [], title }) {
  if (sessionId) {
    const session = await client.beta.sessions.retrieve(sessionId);
    if (session.status === "terminated") throw new SessionError(`session ${sessionId} has terminated`);
    return { session, notes: [] };
  }

  const lock = readLock(dir);
  const agent = lock?.resources?.[`./${AGENT_FILE}`];
  const env = lock?.resources?.[`./${ENV_FILE}`];
  if (!agent || !env) {
    throw new SessionError(`${dir} hasn't been deployed (no agent or environment in ${LOCK_FILE}); run agentschema deploy first`);
  }

  const notes = [];
  const { instance } = check(dir);
  if (instance) {
    if (hashBody(agentBody(instance.agent)) !== agent.hash) notes.push(`${AGENT_FILE} has changed since the last deploy`);
    if (hashBody(envBody(instance.env)) !== env.hash) notes.push(`${ENV_FILE} has changed since the last deploy`);
    if (notes.length > 0) notes.push(`this session uses the deployed version; run agentschema deploy to pick up the changes`);
  }

  // Pin the deployed version, so the session runs exactly what deploy last sent.
  const params = {
    agent: { type: "agent", id: agent.id, version: Number(agent.version) },
    environment_id: env.id,
  };
  if (vaultIds.length > 0) params.vault_ids = vaultIds;
  const name = instance?.agent.data.name;
  params.title = title ?? (name ? `${name} (agentschema run)` : "agentschema run");
  return { session: await client.beta.sessions.create(params), notes };
}

// Drives a session one turn at a time. `ui` answers what only a person can:
//   ui.event(event)          show an event
//   ui.confirm(event)        -> { result: "allow" | "deny", deny_message? } for a paused tool call
//   ui.customToolResult(event) -> string, the result of a custom tool call
export class Conversation {
  constructor(client, sessionId, ui) {
    this.client = client;
    this.sessionId = sessionId;
    this.ui = ui;
    this.seen = new Set();
    this.stream = null;
  }

  // Sends a message and handles events until the agent finishes its turn.
  // Returns the idle stop reason, or "terminated".
  async send(text) {
    return this.#turn([{ type: "user.message", content: [{ type: "text", text }] }]);
  }

  // Asks the agent to stop at the next safe point; the running turn then ends normally.
  async interrupt() {
    await this.client.beta.sessions.events.send(this.sessionId, { events: [{ type: "user.interrupt" }] });
  }

  async #turn(events) {
    // Stream first: events emitted before the stream opens would never reach us.
    this.stream = await this.client.beta.sessions.events.stream(this.sessionId);
    await this.client.beta.sessions.events.send(this.sessionId, { events });

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of this.stream) {
          const done = await this.#handle(event);
          if (done) return done;
        }
        throw new Error("event stream closed");
      } catch (err) {
        if (this.closed || attempt >= 3) throw err;
        // The stream has no replay: reopen it, then catch up from the event history.
        this.stream = await this.client.beta.sessions.events.stream(this.sessionId);
        for await (const event of this.client.beta.sessions.events.list(this.sessionId)) {
          const done = await this.#handle(event);
          if (done) return done;
        }
      }
    }
  }

  // Returns a value when the turn is over.
  async #handle(event) {
    // Events are deduped by ID: the history and the live stream overlap after a reconnect,
    // and a queued user event is echoed twice.
    if (event.id) {
      if (this.seen.has(event.id)) return null;
      this.seen.add(event.id);
    }
    this.ui.event(event);

    const send = (e) => this.client.beta.sessions.events.send(this.sessionId, { events: [e] });
    switch (event.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (event.evaluated_permission === "ask") {
          const { result, deny_message } = await this.ui.confirm(event);
          const reply = { type: "user.tool_confirmation", tool_use_id: event.id, result };
          if (result === "deny" && deny_message) reply.deny_message = deny_message;
          await send(reply);
        }
        return null;
      case "agent.custom_tool_use": {
        const text = await this.ui.customToolResult(event);
        await send({ type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text }] });
        return null;
      }
      case "session.status_idle":
        // requires_action means the session is waiting on one of the replies above.
        return event.stop_reason?.type === "requires_action" ? null : (event.stop_reason?.type ?? "end_turn");
      case "session.status_terminated":
        return "terminated";
      default:
        return null;
    }
  }

  close() {
    this.closed = true;
    this.stream?.controller?.abort();
  }
}
