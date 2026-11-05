import { join } from "node:path";
import { AGENT_FILE, ENV_FILE, agentBody, envBody } from "../lib/instance.js";
import { skillKey, skillRefs } from "../lib/skills.js";
import { TOOLS_DIR } from "../lib/tools.js";
import { credentialKey, vaultKey } from "../lib/vaults.js";
import { check } from "./check.js";
import { LOCK_FILE, hashBody, readLock, skillFingerprint } from "./lock.js";

export class SessionError extends Error {}

// Starts a session on the agent and environment recorded in claude-lock.json, or resumes `sessionId`.
// Returns { session, notes }: notes are warnings worth showing, such as files changed since the last deploy.
export async function openSession(dir, { client, sessionId }) {
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
  const { instance, errors } = check(dir);
  if (instance && errors.length === 0) {
    if (hashBody(agentBody(instance, skillRefs(instance.skills, lock))) !== agent.hash) {
      notes.push(`${AGENT_FILE} or ${TOOLS_DIR}/ has changed since the last deploy`);
    }
    for (const skill of instance.skills) {
      if (hashBody(skillFingerprint(skill)) !== lock.resources[skillKey(skill)]?.hash) notes.push(`${skill.path} has changed since the last deploy`);
    }
    if (hashBody(envBody(instance)) !== env.hash) notes.push(`${ENV_FILE} has changed since the last deploy`);
    if (notes.length > 0) notes.push(`this session uses the deployed version; run agentschema deploy to pick up the changes`);
  }

  const name = instance?.agent.data.name;
  const started = await startSession({
    instance,
    lock,
    client,
    title: name ? `${name} (agentschema run)` : "agentschema run",
    pathOf: (file) => join(dir, file),
  });
  return { session: started.session, notes: [...notes, ...started.notes] };
}

// Starts a session from a lock, pinned to a deployed version, so it runs exactly what deploy sent.
//
//   instance      the checked files, for finding the vaults to attach
//   agentVersion  the agent version to pin, instead of the lock's latest
//   budget        the API's session budget, to cap what the session can spend
//   pathOf        how to show a file's path to the user in messages
//
// Returns { session, notes }.
export async function startSession({ instance, lock, client, agentVersion, title, budget, pathOf = (file) => file }) {
  const agent = lock?.resources?.[`./${AGENT_FILE}`];
  const env = lock?.resources?.[`./${ENV_FILE}`];
  if (!agent || !env) throw new SessionError("this agent hasn't been deployed (no agent or environment in its lock)");

  const params = {
    agent: { type: "agent", id: agent.id, version: Number(agentVersion ?? agent.version) },
    environment_id: env.id,
  };

  // Every deployed vault in vaults/, in name order: when two hold a credential for the same
  // server, the first one wins.
  const notes = [];
  const vaultIds = [];
  for (const vault of instance?.vaults ?? []) {
    const entry = lock.resources[vaultKey(vault)];
    if (!entry) {
      notes.push(`vault ${vault.path} hasn't been deployed, so this session doesn't have it; run agentschema deploy`);
      continue;
    }
    vaultIds.push(entry.id);
    for (const cred of vault.credentials) {
      const credEntry = lock.resources[credentialKey(cred)];
      if (!credEntry || credEntry.vault_id !== entry.id) {
        notes.push(`credential ${cred.file} hasn't been created; run agentschema cred deploy ${pathOf(cred.file)}`);
      }
    }
  }
  if (vaultIds.length > 0) params.vault_ids = vaultIds;
  if (title) params.title = title;
  if (budget) params.budget = budget;
  return { session: await client.beta.sessions.create(params), notes };
}

// Drives a session one turn at a time. `ui` answers what only a person can:
//   ui.event(event)          show an event, including the stream-only event_start / event_delta previews
//   ui.confirm(event)        -> { result: "allow" | "deny", deny_message? } for a paused tool call
//   ui.customToolResult(event) -> string, or { text, isError }: the result of a custom tool call
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
    this.stream = await this.#openStream();
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
        this.stream = await this.#openStream();
        for await (const event of this.client.beta.sessions.events.list(this.sessionId)) {
          const done = await this.#handle(event);
          if (done) return done;
        }
      }
    }
  }

  // Opts in to live previews, so agent text arrives as event_start / event_delta events while
  // the model is still writing, ahead of the complete agent.message.
  #openStream() {
    return this.client.beta.sessions.events.stream(this.sessionId, { event_deltas: ["agent.message"] });
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
        const result = await this.ui.customToolResult(event);
        const { text, isError } = typeof result === "string" ? { text: result } : result;
        const reply = { type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text }] };
        if (isError) reply.is_error = true;
        await send(reply);
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
