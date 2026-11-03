// Lists the agents and sessions in the workspace the credentials belong to.

export async function listAgents(client) {
  const rows = [];
  for await (const agent of client.beta.agents.list()) {
    rows.push({
      name: agent.name,
      id: agent.id,
      version: String(agent.version),
      model: agent.model?.id ?? "",
      updated: formatDate(agent.updated_at),
    });
  }
  return table(rows, { name: "NAME", id: "ID", version: "VERSION", model: "MODEL", updated: "UPDATED" }, "No agents.");
}

export async function listSessions(client) {
  const rows = [];
  // Newest first, the API's default order.
  for await (const session of client.beta.sessions.list()) {
    rows.push({
      id: session.id,
      status: session.status,
      agent: session.agent ? `${session.agent.name} v${session.agent.version}` : "",
      title: truncate(session.title ?? "", 40),
      created: formatDate(session.created_at),
    });
  }
  return table(rows, { id: "ID", status: "STATUS", agent: "AGENT", title: "TITLE", created: "CREATED" }, "No sessions.");
}

// Lines of a plain-text table, with columns padded to their widest value.
function table(rows, headers, empty) {
  if (rows.length === 0) return [empty];
  const keys = Object.keys(headers);
  const widths = keys.map((k) => Math.max(headers[k].length, ...rows.map((r) => r[k].length)));
  const line = (r) => keys.map((k, i) => (i === keys.length - 1 ? r[k] : r[k].padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

// "2026-11-03 14:02" in local time.
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
