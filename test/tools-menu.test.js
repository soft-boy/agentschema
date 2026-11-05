import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { check } from "../src/check.js";
import { agentBody } from "../lib/instance.js";
import { prompts } from "../src/prompts.js";
import { runTool } from "../src/chat.js";
import { toolsCreate } from "../src/tools-menu.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

// The menu, answered through piped input: one line per question.
const menu = (lines) => {
  const input = new PassThrough();
  input.end(lines.map((l) => `${l}\n`).join(""));
  return prompts(input, new PassThrough());
};
const folder = (files = {}) => instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, ...files });

test("tools create writes the pre-built toolset, with the tools you pick", async () => {
  const dir = folder();
  // kind, all eight?, then bash yes and the rest no
  await toolsCreate(dir, { io: menu(["1", "n", "y", "n", "n", "n", "n", "n", "n", "n"]) });
  const { errors, instance: inst } = check(dir);
  assert.deepEqual(errors, []);
  const { configs } = agentBody(inst).tools[0];
  assert.equal(configs.length, 8);
  assert.deepEqual(configs.filter((c) => c.enabled).map((c) => c.name), ["bash"]);

  await assert.rejects(toolsCreate(dir, { io: menu(["1"]) }), /already has its pre-built tools in tools\/agent_toolset_20260401\.md/);
});

test("tools create writes a custom tool whose stub passes check and reports it isn't implemented", async () => {
  const dir = folder();
  // kind, name, description, input name, type, description, required?, no more inputs
  await toolsCreate(dir, { io: menu(["2", "get_weather", "Get the weather: city | country.", "city", "1", "City name", "y", ""]) });
  const { errors, instance: inst } = check(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(agentBody(inst).tools[0], {
    type: "custom",
    name: "get_weather",
    description: "Get the weather: city | country.",
    input_schema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
  });
  assert.deepEqual(await runTool(inst.tools[0], { city: "Oslo" }), { text: "Error: get_weather isn't implemented yet", isError: true });
});

test("a custom tool can take no inputs, and a taken name is asked again", async () => {
  const dir = folder({ "tools/ping.md": "---\ntype: custom\nname: ping\ndescription: Ping.\n---\n\n## Code\n\n```javascript\nmodule.exports = () => 'pong';\n```\n" });
  // kind, taken name, reserved name, then a free one, description, no inputs
  await toolsCreate(dir, { io: menu(["2", "ping", "bash", "pong", "Pong.", ""]) });
  assert.deepEqual(check(dir).errors, []);
  assert.match(readFileSync(join(dir, "tools/pong.md"), "utf8"), /module\.exports = async \(\) =>/);
});

// An MCP server over Streamable HTTP: it needs initialize first, and pages its tools.
async function fakeMcp({ sse = false, status = 200 } = {}) {
  const pages = [{ tools: [{ name: "list_events" }, { name: "delete_event" }], nextCursor: "p2" }, { tools: [{ name: "create_event" }] }];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (status !== 200) return res.writeHead(status).end();
    if (message.id === undefined) return res.writeHead(202).end();
    if (message.method === "tools/list" && req.headers["mcp-session-id"] !== "s1") return res.writeHead(400).end();
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : pages[message.params.cursor ? 1 : 0];
    const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    const headers = { "mcp-session-id": "s1", "content-type": sse ? "text/event-stream" : "application/json" };
    res.writeHead(200, headers).end(sse ? `event: message\ndata: ${reply}\n\n` : reply);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((r) => server.close(r)) };
}

for (const sse of [false, true]) {
  test(`tools create tables every tool an MCP server lists, with the permission chosen (${sse ? "event stream" : "JSON"})`, async () => {
    const server = await fakeMcp({ sse });
    try {
      const dir = folder();
      // kind, URL, name, permission: always_allow
      await toolsCreate(dir, { io: menu(["3", server.url, "calendar", "2"]) });
      const text = readFileSync(join(dir, "tools/calendar.md"), "utf8");
      assert.match(text, /\| `create_event` \| `true` \| `always_allow` \|\n\| `delete_event` \| `true` \| `always_allow` \|\n\| `list_events` \| `true` \| `always_allow` \|/);
      assert.doesNotMatch(text, /default_config/);

      const { errors, instance: inst } = check(dir);
      assert.deepEqual(errors, []);
      const body = agentBody(inst);
      assert.deepEqual(body.mcp_servers, [{ type: "url", name: "calendar", url: server.url }]);
      assert.deepEqual(body.tools, [{
        type: "mcp_toolset",
        mcp_server_name: "calendar",
        configs: ["create_event", "delete_event", "list_events"].map((name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } })),
      }]);
    } finally {
      await server.close();
    }
  });
}

test("the table states the default permission too", async () => {
  const server = await fakeMcp();
  try {
    const dir = folder();
    await toolsCreate(dir, { io: menu(["3", server.url, "calendar", "1"]) });
    assert.match(readFileSync(join(dir, "tools/calendar.md"), "utf8"), /\| `list_events` \| `true` \| `always_ask` \|/);
  } finally {
    await server.close();
  }
});

test("an MCP server that won't list its tools gets no table, and the permission as a default", async () => {
  const server = await fakeMcp({ status: 401 });
  try {
    const dir = folder();
    const lines = [];
    await toolsCreate(dir, { io: menu(["3", server.url, "example", "2"]), log: (l) => lines.push(l) });
    assert.match(lines.join("\n"), /won't list its tools without signing in/);
    const { errors, warnings, instance: inst } = check(dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(agentBody(inst).tools, [{ type: "mcp_toolset", mcp_server_name: "example", default_config: { permission_policy: { type: "always_allow" } } }]);
    assert.match(warnings.join("\n"), /limited networking doesn't allow MCP server `example` \(127\.0\.0\.1:\d+\)/);
    assert.match(lines.join("\n"), /warning: env\.md: .*limited networking/);
  } finally {
    await server.close();
  }
});

test("the default name for an MCP server comes from its URL", async () => {
  const dir = folder();
  const unreachable = async () => { throw new Error("offline"); };
  await toolsCreate(dir, { io: menu(["3", "https://calendarmcp.googleapis.com/mcp/v1", "", "1"]), fetch: unreachable });
  assert.match(readFileSync(join(dir, "tools/calendar.md"), "utf8"), /^---\ntype: mcp_toolset\nmcp_server_name: calendar\n---\n/);
  assert.match(readFileSync(join(dir, "agent.md"), "utf8"), /name: calendar\n\s+url: https:\/\/calendarmcp\.googleapis\.com\/mcp\/v1\n/);
});

test("tools create declares the server in agent.md, keeping the rest of the file", async () => {
  const offline = async () => { throw new Error("offline"); };
  const agent = "---\nname: Helper # keep this comment\nmodel: claude-opus-5-5\ndescription: " + "a long description ".repeat(10).trim() + "\n---\n\nYou are helpful.\n\n---\n\nStill the prompt.\n";
  const dir = instance({ "agent.md": agent, "env.md": ENV_MD });
  await toolsCreate(dir, { io: menu(["3", "https://a.example/mcp", "first", "1"]), fetch: offline });
  await toolsCreate(dir, { io: menu(["3", "https://b.example/mcp", "second", "1"]), fetch: offline });

  const text = readFileSync(join(dir, "agent.md"), "utf8");
  assert.match(text, /name: Helper # keep this comment/);
  assert.match(text, /description: (a long description ){9}a long description\n/);
  assert.ok(text.endsWith("\n---\n\nYou are helpful.\n\n---\n\nStill the prompt.\n"));
  const { errors, instance: inst } = check(dir);
  assert.deepEqual(errors, []);
  const body = agentBody(inst);
  assert.equal(body.system, "You are helpful.\n\n---\n\nStill the prompt.");
  assert.deepEqual(body.mcp_servers, [
    { type: "url", name: "first", url: "https://a.example/mcp" },
    { type: "url", name: "second", url: "https://b.example/mcp" },
  ]);
  assert.deepEqual(body.tools.map((t) => t.mcp_server_name), ["first", "second"]);
});

test("a server agent.md already declares only gets its toolset file", async () => {
  const offline = async () => { throw new Error("offline"); };
  const agent = AGENT_MD.replace("model: claude-opus-5-5\n", "model: claude-opus-5-5\nmcp_servers:\n  - type: url\n    name: linear\n    url: https://mcp.linear.app/mcp\n");
  const dir = instance({ "agent.md": agent, "env.md": ENV_MD });
  // kind, URL, permission: no name question, since agent.md has it
  await toolsCreate(dir, { io: menu(["3", "https://mcp.linear.app/mcp", "1"]), fetch: offline });
  assert.equal(readFileSync(join(dir, "agent.md"), "utf8"), agent);
  assert.deepEqual(check(dir).errors, []);
  // Now it has one: the same URL is asked for again, and input runs out.
  await assert.rejects(toolsCreate(dir, { io: menu(["3", "https://mcp.linear.app/mcp"]), fetch: offline }), /cancelled/);
});

test("MCP servers and their toolset files are checked against each other", () => {
  const server = "mcp_servers:\n  - type: url\n    name: x\n    url: https://a.example/mcp\n";
  const agent = AGENT_MD.replace("model: claude-opus-5-5\n", `model: claude-opus-5-5\n${server}`);
  const errs = (md, a = agent) => check(instance({ "agent.md": a, "env.md": ENV_MD, ...(md ? { "tools/x.md": md } : {}) })).errors.join("\n");
  const toolset = "---\ntype: mcp_toolset\nmcp_server_name: x\n---\n";

  assert.equal(errs(toolset), "");
  assert.match(errs(null), /`x` has no toolset; add tools\/x\.md/);
  assert.match(errs(toolset, AGENT_MD), /tools\/x\.md: `x` isn't in agent\.md's `mcp_servers`/);
  assert.match(errs("---\ntype: mcp_toolset\n---\n"), /`mcp_server_name` is required/);
  assert.match(errs("---\ntype: mcp_toolset\nmcp_server_name: y\n---\n"), /must match the file name \(x\)/);
  assert.match(errs(`${toolset.slice(0, -4)}url: https://a.example/mcp\n---\n`), /`url` belongs in agent\.md's `mcp_servers`/);
  assert.match(errs(`${toolset.slice(0, -4)}default_config:\n  enabled: maybe\n---\n`), /default_config.enabled` must be true or false/);
  assert.match(errs(`${toolset.slice(0, -4)}default_config:\n  permission_policy:\n    type: sometimes\n---\n`), /permission_policy.type` must be/);
  assert.match(errs(`${toolset}\n## Tools\n\n| Name | Enabled |\n|---|---|\n| a | yes |\n`), /`a`: Enabled must be true or false/);
  assert.match(errs(toolset, agent.replace("https://a.example/mcp", "not a url")), /`x` needs a `url`/);
  assert.match(errs(toolset, agent.replace("type: url", "type: stdio")), /`x` must have `type: url`/);
  assert.match(errs(toolset, agent.replace(server, server + server.slice("mcp_servers:\n".length))), /`x` is declared twice/);

  const twice = check(instance({ "agent.md": agent, "env.md": ENV_MD, "tools/a/x.md": toolset, "tools/x.md": toolset }));
  assert.match(twice.errors.join("\n"), /more than one MCP server is named `x`/);
});
