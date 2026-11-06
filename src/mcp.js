import { readTools, MCP_TOOLSET, mcpToolsetFile } from "../lib/tools.js";
import { readInstance } from "../lib/instance.js";

// Just enough of the MCP client protocol (Streamable HTTP) to ask a server for its tools.

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 10_000;

// The names of the tools an MCP server offers, sorted. Returns null when the server won't say, or
// can't be reached. Many only say once you've signed in, so `token` is sent if it's given.
export async function listMcpTools(url, { fetch = globalThis.fetch, token, clientName = "agentschema" } = {}) {
  try {
    let sessionId = null;
    const send = async (message) => {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT_MS) });
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      if (!res.ok) throw new Error(`status ${res.status}`);
      return message.id === undefined ? null : parseResponse(await res.text(), message.id);
    };

    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: "0" } },
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

// The tool file for the server at `url`, now listing its tools, once there's a way to ask. Returns
// { path, text }, or null if there's nothing to change: the file has a table already, so it may hold
// choices worth keeping, or the agent has no file for that server, or it won't say what it offers.
export async function listedMcpToolset(files, url, options = {}) {
  const servers = readInstance(files).agent?.data.mcp_servers;
  const server = Array.isArray(servers) ? servers.find((candidate) => candidate?.url === url) : null;
  if (!server) return null;
  const tool = readTools(files).tools.find((candidate) => candidate.data.type === MCP_TOOLSET && candidate.data.mcp_server_name === server.name);
  if (!tool || tool.rows?.length) return null;

  const names = await listMcpTools(url, options);
  if (!names?.length) return null;
  return { path: tool.file, text: mcpToolsetFile({ name: server.name, tools: names, permission: tool.data.default_config?.permission_policy?.type ?? "always_ask" }) };
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
