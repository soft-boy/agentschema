import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadEnvFile, parseEnvFile } from "../src/dotenv.js";
import { AGENT_MD, ENV_MD } from "./helpers.js";

const folder = () => mkdtempSync(join(tmpdir(), "agentschema-dotenv-"));

test(".env lines parse the way a shell would read them", () => {
  const { values, bad } = parseEnvFile([
    "# a comment", "", "PLAIN=value", "export EXPORTED=yes", "SPACED = around  ", "COMMENTED=value # note", "HASH=a#b",
    `DOUBLE="two words # kept"`, `ESCAPED="line\\nbreak \\"q\\""`, "SINGLE='no \\n escapes'", "EMPTY=", "PATH_LIKE=~/.config/key.json",
    "not a pair", `OPEN="never closed`,
  ].join("\n"));
  assert.deepEqual(values, {
    PLAIN: "value", EXPORTED: "yes", SPACED: "around", COMMENTED: "value", HASH: "a#b",
    DOUBLE: "two words # kept", ESCAPED: 'line\nbreak "q"', SINGLE: "no \\n escapes", EMPTY: "", PATH_LIKE: "~/.config/key.json",
  });
  assert.deepEqual(bad, [13, 14]);
});

test("a variable set in the shell wins, and a missing file is fine", () => {
  const dir = folder();
  const env = { SHELL_SET: "from shell" };
  assert.deepEqual(loadEnvFile(dir, env), []);
  writeFileSync(join(dir, ".env"), "SHELL_SET=from file\nNEW=from file\nTOKEN abc123\n");
  const warnings = loadEnvFile(dir, env);
  assert.deepEqual(env, { SHELL_SET: "from shell", NEW: "from file" });
  assert.deepEqual(warnings, [".env:3: not a KEY=VALUE line, so it was skipped"]);
});

// Runs the real CLI against a fake API, with an agent whose custom tool reports two variables.
test("run gives the folder's .env to custom tools, but not to the Anthropic client", async () => {
  const dir = folder();
  writeFileSync(join(dir, "agent.md"), AGENT_MD);
  writeFileSync(join(dir, "env.md"), ENV_MD);
  mkdirSync(join(dir, "tools"));
  writeFileSync(join(dir, "tools/report.md"), [
    "---", "type: custom", "name: report", "description: Report settings.", "---", "", "## Code", "", "```javascript",
    "module.exports = () => `${process.env.FROM_FILE}/${process.env.FROM_SHELL}`;", "```", "",
  ].join("\n"));
  writeFileSync(join(dir, ".env"), "FROM_FILE=file\nFROM_SHELL=file\nANTHROPIC_API_KEY=key_from_dotenv\n");
  writeFileSync(join(dir, "claude-lock.json"), JSON.stringify({
    version: 1,
    resources: { "./agent.md": { kind: "agent", id: "agent_1", version: "1", hash: "x" }, "./env.md": { kind: "environment", id: "env_1", hash: "x" } },
  }));

  const keys = new Set();
  let stream = null;
  let result = null;
  const emit = (event) => stream.write(`event: message\ndata: ${JSON.stringify({ processed_at: new Date().toISOString(), ...event })}\n\n`);
  const server = createServer(async (req, res) => {
    keys.add(req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, ""));
    let body = "";
    for await (const chunk of req) body += chunk;
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/v1/sessions" && req.method === "POST") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "sesn_1", status: "idle" }));
    }
    if (pathname === "/v1/sessions/sesn_1/events/stream") {
      stream = res;
      return res.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
    }
    if (pathname === "/v1/sessions/sesn_1/events" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      for (const event of JSON.parse(body).events) {
        if (event.type === "user.message") emit({ id: "sevt_1", type: "agent.custom_tool_use", name: "report", input: {} });
        if (event.type === "user.custom_tool_result") {
          result = event.content[0].text;
          emit({ id: "sevt_2", type: "session.status_idle", stop_reason: { type: "end_turn" } });
        }
      }
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const child = spawn(process.execPath, ["bin/agentschema.js", "run", dir], {
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "key_from_shell", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, FROM_SHELL: "shell" },
      stdio: ["pipe", "ignore", "inherit"],
    });
    child.stdin.write("hello\n");
    const deadline = Date.now() + 10_000;
    while (result === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));

    assert.equal(result, "file/shell");
    assert.deepEqual([...keys], ["key_from_shell"]);
  } finally {
    stream?.end();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
