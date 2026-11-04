import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const cli = (...args) => spawnSync(process.execPath, ["bin/agentschema.js", ...args], { encoding: "utf8" });

test("the top-level help lists command groups; each group's help lists its commands", () => {
  const top = cli("-h").stdout;
  assert.match(top, /cred <command>\s+Create and manage the credentials/);
  assert.match(top, /sessions <command>\s+List and delete sessions/);
  assert.doesNotMatch(top, /deploy <file>|delete <id>|--port/);

  for (const args of [["cred", "-h"], ["cred", "create", "--help"]]) {
    const out = cli(...args).stdout;
    assert.match(out, /Usage: agentschema cred <command>/);
    assert.match(out, /deploy <file>\s+Create the credential a file describes in Anthropic/);
    assert.match(out, /--port <port>/);
  }
  assert.match(cli("sessions", "-h").stdout, /delete <id>\s+Delete a session/);
});

test("a group without a command, or with an unknown one, prints the group's help", () => {
  const bare = cli("cred");
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Usage: agentschema cred <command>/);
  const unknown = cli("sessions", "show");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command "sessions show"[\s\S]*Usage: agentschema sessions <command>/);
});
