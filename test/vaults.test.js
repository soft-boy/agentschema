import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { check } from "../src/check.js";
import { credDelete, credLogin, credPaste } from "../src/cred.js";
import { DeployError, deploy } from "../src/deploy.js";
import { openSession } from "../src/session.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

const SLACK_MD = `---
auth:
  type: mcp_oauth
  mcp_server_url: https://mcp.slack.com/mcp
  refresh:
    token_endpoint: https://slack.com/api/oauth.v2.user.access
    client_id: "1234567890.0987654321"
    scope: channels:read chat:write
    token_endpoint_auth:
      type: client_secret_post
---

The ops bot's Slack token.
`;

const LINEAR_MD = `---
auth:
  type: mcp_oauth
  mcp_server_url: https://mcp.linear.app/mcp
---
`;

const folder = (files = {}) => instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, ...files });
const errorsFor = (files) => check(folder(files)).errors.join("\n");
const lockOf = (dir) => JSON.parse(readFileSync(join(dir, "claude-lock.json"), "utf8"));

// An in-memory stand-in for the agents, environments, vaults and sessions APIs.
function fakeClient() {
  const calls = [];
  const store = new Map();
  let n = 0;
  const notFound = () => new Anthropic.NotFoundError(404, {}, "not found", new Headers());
  const resource = (kind) => ({
    create: async (body) => {
      calls.push([`${kind}.create`, body]);
      const obj = { id: `${kind}_${++n}`, version: 1, metadata: {}, ...body };
      store.set(obj.id, obj);
      return obj;
    },
    retrieve: async (id) => {
      if (!store.has(id)) throw notFound();
      return store.get(id);
    },
    update: async (id, body) => {
      calls.push([`${kind}.update`, id, body]);
      return Object.assign(store.get(id), body);
    },
  });
  const credentials = {
    create: async (vaultId, body) => {
      calls.push(["credential.create", vaultId, body]);
      const obj = { id: `vcrd_${++n}`, vault_id: vaultId, metadata: {}, ...structuredClone(body) };
      store.set(obj.id, obj);
      return obj;
    },
    retrieve: async (id) => {
      if (!store.has(id)) throw notFound();
      return store.get(id);
    },
    update: async (id, body) => {
      calls.push(["credential.update", id, body]);
      return store.get(id);
    },
    delete: async (id, params) => {
      calls.push(["credential.delete", id, params]);
      store.delete(id);
      return { id };
    },
    mcpOAuthValidate: async () => ({ status: "valid" }),
  };
  return {
    baseURL: "https://api.anthropic.com",
    calls,
    store,
    beta: {
      agents: resource("agent"),
      environments: resource("env"),
      vaults: { ...resource("vault"), credentials },
      sessions: { create: async (params) => (calls.push(["session.create", params]), { id: "sesn_1", ...params }) },
    },
  };
}

// Answers cred deploy's paste questions in order: access token, expiry, refresh token, client secret.
const answers = (...replies) => async () => replies.shift() ?? "";

test("credential files are checked, and secrets in them are errors", () => {
  assert.equal(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD, "vaults/Ops/vault.md": "---\nmetadata:\n  team: ops\n---\n" }), "");
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD.replace("  refresh:", "  access_token: abc\n  refresh:") }), /`auth.access_token` doesn't go in the file/);
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD.replace("client_secret_post", "client_secret_post\n      client_secret: abc") }), /`auth.refresh.token_endpoint_auth.client_secret` doesn't go in the file/);
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD.replace("mcp_oauth", "static_bearer") }), /other credential types aren't supported yet/);
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD.replace('"1234567890.0987654321"', "1234567890.0987654321") }), /client_id` is required, as a string/);
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD.replace("type: client_secret_post", "type: secret") }), /token_endpoint_auth.type` must be/);
  assert.match(errorsFor({ "vaults/Ops/Slack.md": SLACK_MD, "vaults/Ops/Slack2.md": SLACK_MD }), /already a credential for https:\/\/mcp\.slack\.com\/mcp/);
  assert.match(errorsFor({ "vaults/Ops/vault.md": "---\ndisplay_name: Ops\n---\n" }), /the folder name is the vault's name/);
  assert.match(errorsFor({ "vaults/Slack.md": SLACK_MD }), /each vault is a folder/);
});

test("deploy creates vaults, and reports credentials it can't create without secrets", async () => {
  const dir = folder({ "vaults/Ops/Slack.md": SLACK_MD, "vaults/Ops/vault.md": "---\nmetadata:\n  team: ops\n---\n" });
  const client = fakeClient();
  const lines = [];
  const plan = await deploy(dir, { client, log: (l) => lines.push(l) });

  assert.deepEqual(client.calls.find((c) => c[0] === "vault.create")[1], { display_name: "Ops", metadata: { team: "ops" } });
  assert.equal(client.calls.some((c) => c[0] === "credential.create"), false);
  assert.deepEqual(plan.slice(2).map((p) => [p.kind, p.action]), [["vault", "create"], ["credential", "missing"]]);
  assert.match(lines.at(-1), /missing\s+credential vaults\/Ops\/Slack\.md \(create it with: agentschema cred deploy .*vaults\/Ops\/Slack\.md\)/);
  assert.equal(lockOf(dir).resources["./vaults/Ops"].kind, "vault");
});

test("pasting tokens sends the secrets to the vault and keeps them out of the lock", async () => {
  const dir = folder({ "vaults/Ops/Slack.md": SLACK_MD });
  const client = fakeClient();
  await credPaste(join(dir, "vaults/Ops/Slack.md"), { client, ask: answers("xoxp-access", "2099-12-31T23:59:59Z", "xoxe-refresh", "shh") });

  const [, vaultId, body] = client.calls.find((c) => c[0] === "credential.create");
  assert.equal(client.calls[0][0], "vault.create");
  assert.deepEqual(body, {
    display_name: "Slack",
    auth: {
      type: "mcp_oauth",
      mcp_server_url: "https://mcp.slack.com/mcp",
      access_token: "xoxp-access",
      expires_at: "2099-12-31T23:59:59.000Z",
      refresh: {
        token_endpoint: "https://slack.com/api/oauth.v2.user.access",
        client_id: "1234567890.0987654321",
        scope: "channels:read chat:write",
        refresh_token: "xoxe-refresh",
        token_endpoint_auth: { type: "client_secret_post", client_secret: "shh" },
      },
    },
  });
  const lockText = readFileSync(join(dir, "claude-lock.json"), "utf8");
  assert.doesNotMatch(lockText, /xoxp|xoxe|shh/);
  assert.equal(lockOf(dir).resources["./vaults/Ops/Slack.md"].vault_id, vaultId);

  // Created already: a second create is refused, and deploy finds nothing to do.
  await assert.rejects(credPaste(join(dir, "vaults/Ops/Slack.md"), { client, ask: answers("x") }), /already created/);
  client.calls.length = 0;
  const plan = await deploy(dir, { client });
  assert.deepEqual(plan.slice(2).map((p) => p.action), ["unchanged", "unchanged"]);
});

test("pasting tokens only asks for the secrets the file needs", async () => {
  const dir = folder({ "vaults/Ops/Linear.md": LINEAR_MD });
  const client = fakeClient();
  const asked = [];
  await credPaste(join(dir, "vaults/Ops/Linear.md"), { client, ask: async (q, { secret }) => (asked.push([q, secret]), asked.length === 1 ? "lin_token" : "") });
  assert.deepEqual(asked.map(([q, secret]) => [q.split(" ")[0], secret]), [["Access", true], ["Access", false]]);
  const body = client.calls.find((c) => c[0] === "credential.create")[2];
  assert.deepEqual(body.auth, { type: "mcp_oauth", mcp_server_url: "https://mcp.linear.app/mcp", access_token: "lin_token" });
});

test("deploy updates a credential's scope and metadata, but stops on an immutable field", async () => {
  const dir = folder({ "vaults/Ops/Slack.md": SLACK_MD });
  const client = fakeClient();
  await credPaste(join(dir, "vaults/Ops/Slack.md"), { client, ask: answers("a", "", "r", "s") });

  writeFileSync(join(dir, "vaults/Ops/Slack.md"), SLACK_MD.replace("chat:write", "chat:write users:read"));
  client.calls.length = 0;
  await deploy(dir, { client });
  const [, , body] = client.calls.find((c) => c[0] === "credential.update");
  assert.deepEqual(body.auth, { type: "mcp_oauth", refresh: { scope: "channels:read chat:write users:read" } });
  assert.equal("access_token" in body.auth, false);

  writeFileSync(join(dir, "vaults/Ops/Slack.md"), SLACK_MD.replace("mcp.slack.com", "mcp.slack-gov.com"));
  client.calls.length = 0;
  await assert.rejects(deploy(dir, { client }), (err) => err instanceof DeployError && /`auth.mcp_server_url` can't be changed.*cred delete/.test(err.message));
  assert.equal(client.calls.some((c) => c[0] === "credential.update"), false);
});

test("cred delete removes the credential and its lock entry, keeping the file", async () => {
  const dir = folder({ "vaults/Ops/Linear.md": LINEAR_MD });
  const client = fakeClient();
  await credPaste(join(dir, "vaults/Ops/Linear.md"), { client, ask: answers("t") });
  const { id, vault_id } = lockOf(dir).resources["./vaults/Ops/Linear.md"];

  await credDelete(join(dir, "vaults/Ops/Linear.md"), { client, confirm: async () => true });
  assert.deepEqual(client.calls.at(-1), ["credential.delete", id, { vault_id }]);
  assert.equal(lockOf(dir).resources["./vaults/Ops/Linear.md"], undefined);
  assert.equal(check(dir).errors.length, 0);
});

test("run attaches the deployed vaults in name order, and notes the rest", async () => {
  const dir = folder({ "vaults/b-shared/Linear.md": LINEAR_MD, "vaults/a-user/vault.md": "---\n---\n", "vaults/c-new/vault.md": "---\n---\n" });
  const client = fakeClient();
  await deploy(dir, { client });
  const lock = lockOf(dir);
  delete lock.resources["./vaults/c-new"];
  writeFileSync(join(dir, "claude-lock.json"), JSON.stringify(lock));

  const { session, notes } = await openSession(dir, { client });
  assert.deepEqual(session.vault_ids, [lock.resources["./vaults/a-user"].id, lock.resources["./vaults/b-shared"].id]);
  assert.match(notes.join("\n"), /credential vaults\/b-shared\/Linear\.md hasn't been created/);
  assert.match(notes.join("\n"), /vault vaults\/c-new hasn't been deployed/);
});

const STRIPE_MD = `---
auth:
  type: environment_variable
  secret_name: STRIPE_API_KEY
  networking:
    type: limited
    allowed_hosts:
      - api.stripe.com
  injection_location:
    header: true
---

The billing agent's Stripe key.
`;
const stripeEnv = ENV_MD.replace("type: limited\n", "type: limited\n    allowed_hosts:\n      - api.stripe.com\n");

test("environment variable credentials are checked", () => {
  const errs = (md, env = stripeEnv) => check(instance({ "agent.md": AGENT_MD, "env.md": env, "vaults/Ops/Stripe.md": md })).errors.join("\n");
  assert.equal(errs(STRIPE_MD), "");
  assert.match(errs(STRIPE_MD.replace("  networking:", "  secret_value: abc\n  networking:")), /`auth.secret_value` doesn't go in the file/);
  assert.match(errs(STRIPE_MD.replace("STRIPE_API_KEY", "not a name")), /`auth.secret_name` is required/);
  assert.match(errs(STRIPE_MD.replace("type: limited", "type: open")), /`auth.networking.type` is required/);
  assert.match(errs(STRIPE_MD.replace("      - api.stripe.com\n", "").replace("allowed_hosts:", "allowed_hosts: []")), /allowed_hosts` must list the hosts/);
  assert.match(errs(STRIPE_MD.replace("header: true", "header: false")), /must enable `header` or `body`/);
  assert.match(
    check(instance({ "agent.md": AGENT_MD, "env.md": stripeEnv, "vaults/Ops/A.md": STRIPE_MD, "vaults/Ops/B.md": STRIPE_MD })).errors.join("\n"),
    /already sets STRIPE_API_KEY; a vault holds one per variable/,
  );
});

test("environment variable credentials warn about what they depend on", () => {
  const warningsFor = (files, env = stripeEnv) => check(instance({ "agent.md": AGENT_MD, "env.md": env, ...files })).warnings.join("\n");
  assert.equal(warningsFor({ "vaults/Ops/Stripe.md": STRIPE_MD }), "");
  assert.match(warningsFor({ "vaults/Ops/Stripe.md": STRIPE_MD }, ENV_MD), /limited networking doesn't allow api\.stripe\.com/);
  assert.match(warningsFor({ "vaults/Ops/Stripe.md": STRIPE_MD.replace(/type: limited\n\s+allowed_hosts:\n\s+- api\.stripe\.com/, "type: unrestricted") }), /substituted on requests to any host/);
  assert.match(warningsFor({ "vaults/Ops/Stripe.md": STRIPE_MD }, stripeEnv.replace("type: cloud", "type: self_hosted")), /aren't supported on self-hosted/);
  assert.match(warningsFor({ "vaults/A/Stripe.md": STRIPE_MD, "vaults/B/Stripe.md": STRIPE_MD }), /also sets STRIPE_API_KEY, and the API doesn't document which vault wins/);
});

test("an environment variable credential sends its value on create, and its settings on update", async () => {
  const dir = instance({ "agent.md": AGENT_MD, "env.md": stripeEnv, "vaults/Ops/Stripe.md": STRIPE_MD });
  const client = fakeClient();
  let validated = false;
  client.beta.vaults.credentials.mcpOAuthValidate = async () => { validated = true; return { status: "valid" }; };
  await credPaste(join(dir, "vaults/Ops/Stripe.md"), { client, ask: answers("sk_test_1") });

  const [, , body] = client.calls.find((c) => c[0] === "credential.create");
  assert.deepEqual(body.auth, {
    type: "environment_variable",
    secret_name: "STRIPE_API_KEY",
    secret_value: "sk_test_1",
    networking: { type: "limited", allowed_hosts: ["api.stripe.com"] },
    injection_location: { header: true },
  });
  assert.equal(validated, false);
  assert.doesNotMatch(readFileSync(join(dir, "claude-lock.json"), "utf8"), /sk_test_1/);

  // A new host and a body location update in place, and never resend the value.
  writeFileSync(join(dir, "vaults/Ops/Stripe.md"), STRIPE_MD.replace("      - api.stripe.com", "      - api.stripe.com\n      - files.stripe.com").replace("header: true", "body: true"));
  client.calls.length = 0;
  await deploy(dir, { client });
  const update = client.calls.find((c) => c[0] === "credential.update")[2];
  assert.deepEqual(update.auth, {
    type: "environment_variable",
    networking: { type: "limited", allowed_hosts: ["api.stripe.com", "files.stripe.com"] },
    injection_location: { header: false, body: true },
  });

  // The variable's name can't change.
  writeFileSync(join(dir, "vaults/Ops/Stripe.md"), STRIPE_MD.replace("STRIPE_API_KEY", "STRIPE_KEY"));
  await assert.rejects(deploy(dir, { client }), /`auth.secret_name` can't be changed/);
  await assert.rejects(credLogin(join(dir, "vaults/Ops/Stripe.md"), { client, ask: answers(), openBrowser: () => {} }), /nothing to sign in to/);
});
