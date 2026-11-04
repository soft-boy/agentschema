// Just enough of the MCP client protocol (Streamable HTTP) to ask a server for its tools.

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 10_000;

// The names of the tools an MCP server offers, sorted. Returns null when the server won't say
// without signing in, or can't be reached. Sends no credentials.
export async function listMcpTools(url, { fetch = globalThis.fetch } = {}) {
  try {
    let sessionId = null;
    const send = async (message) => {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS) });
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      if (!res.ok) throw new Error(`status ${res.status}`);
      return message.id === undefined ? null : parseResponse(await res.text(), message.id);
    };

    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agentschema", version: "0" } },
    });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const names = [];
    let cursor;
    let id = 2;
    do {
      const { result } = await send({ jsonrpc: "2.0", id: id++, method: "tools/list", params: cursor ? { cursor } : {} });
      names.push(...result.tools.map((t) => t.name));
      cursor = result.nextCursor;
    } while (cursor);
    return [...new Set(names)].sort();
  } catch {
    return null;
  }
}

// A response is either plain JSON, or a stream of events with the JSON in a `data:` line.
function parseResponse(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return checked(JSON.parse(trimmed));
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const message = JSON.parse(line.slice(5));
    if (message.id === id) return checked(message);
  }
  throw new Error("no response");
}

function checked(message) {
  if (message.error) throw new Error(message.error.message);
  return message;
}
