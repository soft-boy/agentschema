export class DeleteError extends Error {}

// Agents can't be deleted, only archived: an archived agent drops out of `list`, and
// there's no unarchive. `confirm(question)` resolves to true to go ahead.
export async function deleteAgent(client, agentId, { confirm, log }) {
  const agent = await client.beta.agents.retrieve(agentId);
  if (agent.archived_at) throw new DeleteError(`${agentId} is already archived`);
  const ok = await confirm(`Archive agent "${agent.name}" (${agentId})? It can't be undone.`);
  if (!ok) return log("Nothing changed.");
  await client.beta.agents.archive(agentId);
  log(`Archived ${agentId}.`);
}

// Deletes a session and its event history for good.
export async function deleteSession(client, sessionId, { confirm, log }) {
  const session = await client.beta.sessions.retrieve(sessionId);
  if (session.status === "running") {
    throw new DeleteError(`${sessionId} is running; wait for it to go idle, or interrupt it, then try again`);
  }
  const label = session.title ? `"${session.title}" (${sessionId})` : sessionId;
  const ok = await confirm(`Delete session ${label} and its history? It can't be undone.`);
  if (!ok) return log("Nothing changed.");
  await client.beta.sessions.delete(sessionId);
  log(`Deleted ${sessionId}.`);
}
