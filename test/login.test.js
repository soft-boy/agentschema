import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { test } from "node:test";
import { check } from "../src/check.js";
import { credCreate, credDeploy } from "../src/cred-menu.js";
import { credLogin } from "../src/cred.js";
import { prompts } from "../src/prompts.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

// A local MCP server and authorization server: protected resource metadata, authorization
// server metadata, client registration, an authorize endpoint that approves at once, and a
// token endpoint that checks the PKCE verifier.
async function fakeOAuth({ registration = true, refreshToken = "rt_1", path = "/mcp" } = {}) {
  const seen = { authorize: null, token: null, registered: null };
  const challenges = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let body = "";
    for await (const chunk of req) body += chunk;

    if (url.pathname === `/.well-known/oauth-protected-resource${path}`) {
      return json(200, { resource: `${origin}${path}`, authorization_servers: [`${origin}/auth`], scopes_supported: ["read", "write"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
      return json(200, {
        issuer: `${origin}/auth`,
        authorization_endpoint: `${origin}/auth/authorize`,
        token_endpoint: `${origin}/auth/token`,
        ...(registration ? { registration_endpoint: `${origin}/auth/register` } : {}),
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/auth/register") {
      seen.registered = JSON.parse(body);
      return json(201, { client_id: "dyn_client", token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/auth/authorize") {
      seen.authorize = Object.fromEntries(url.searchParams);
      challenges.set("code_1", url.searchParams.get("code_challenge"));
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "code_1");
      back.searchParams.set("state", url.searchParams.get("state"));
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/auth/token") {
      const form = Object.fromEntries(new URLSearchParams(body));
      seen.token = { form, authorization: req.headers.authorization ?? null };
      const expected = challenges.get(form.code);
      const actual = createHash("sha256").update(form.code_verifier).digest("base64url");
      if (expected !== actual) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "at_1", expires_in: 3600, scope: "read", ...(refreshToken ? { refresh_token: refreshToken } : {}) });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}${path}`, seen, close: () => new Promise((r) => server.close(r)) };
}

// Plays the browser: follows the authorize redirect back to the local callback.
const browser = async (url) => {
  const res = await fetch(url, { redirect: "manual" });
  await fetch(res.headers.get("location"));
};

function fakeClient() {
  const calls = [];
  let n = 0;
  const store = new Map();
  return {
    baseURL: "https://api.anthropic.com",
    calls,
    beta: {
      vaults: {
        create: async (body) => (calls.push(["vault.create", body]), { id: `vlt_${++n}`, ...body }),
        credentials: {
          create: async (vaultId, body) => {
            calls.push(["credential.create", vaultId, body]);
            const obj = { id: `vcrd_${++n}`, vault_id: vaultId, ...structuredClone(body) };
            store.set(obj.id, obj);
            return obj;
          },
          retrieve: async (id) => store.get(id),
          update: async (id, body) => (calls.push(["credential.update", id, body]), store.get(id)),
          mcpOAuthValidate: async () => ({ status: "valid" }),
        },
      },
    },
  };
}

const credFile = (url, refresh = "") => `---\nauth:\n  type: mcp_oauth\n  mcp_server_url: ${url}\n${refresh}---\n\nA note.\n`;
const noSecrets = async () => assert.fail("nothing should be asked");

test("cred login registers a client, signs in with PKCE, and writes the refresh block", async () => {
  const oauth = await fakeOAuth();
  try {
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, "vaults/Ops/Linear.md": credFile(oauth.url) });
    const client = fakeClient();
    const file = join(dir, "vaults/Ops/Linear.md");
    await credLogin(file, { client, ask: noSecrets, openBrowser: browser });

    assert.equal(oauth.seen.registered.token_endpoint_auth_method, "none");
    assert.equal(oauth.seen.authorize.client_id, "dyn_client");
    assert.equal(oauth.seen.authorize.code_challenge_method, "S256");
    assert.equal(oauth.seen.authorize.resource, oauth.url);
    assert.equal(oauth.seen.token.form.client_id, "dyn_client");

    const [, , body] = client.calls.find((c) => c[0] === "credential.create");
    assert.equal(body.auth.access_token, "at_1");
    assert.equal(body.auth.refresh.refresh_token, "rt_1");
    assert.deepEqual(body.auth.refresh.token_endpoint_auth, { type: "none" });
    assert.ok(Date.parse(body.auth.expires_at) > Date.now());

    // The file gained the client and endpoint, kept its note, has no tokens, and passes check.
    const text = readFileSync(file, "utf8");
    assert.match(text, /client_id: dyn_client/);
    assert.match(text, new RegExp(`token_endpoint: ${oauth.origin}/auth/token`));
    assert.match(text, /\n\nA note\.\n$/);
    assert.doesNotMatch(text, /at_1|rt_1/);
    assert.deepEqual(check(dir).errors, []);
    assert.doesNotMatch(readFileSync(join(dir, "claude-lock.json"), "utf8"), /at_1|rt_1/);

    // Signing in again replaces the tokens instead of creating another credential.
    await credLogin(file, { client, ask: noSecrets, openBrowser: browser });
    const update = client.calls.find((c) => c[0] === "credential.update");
    assert.deepEqual(update[2].auth.refresh, { refresh_token: "rt_1" });
    assert.equal(client.calls.filter((c) => c[0] === "credential.create").length, 1);
  } finally {
    await oauth.close();
  }
});

test("cred login uses the file's own client, asking for its secret", async () => {
  const oauth = await fakeOAuth({ registration: false });
  try {
    const refresh = `  refresh:\n    token_endpoint: ${oauth.origin}/auth/token\n    client_id: my_client\n    scope: read write\n    token_endpoint_auth:\n      type: client_secret_basic\n`;
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, "vaults/Ops/Cal.md": credFile(oauth.url, refresh) });
    const client = fakeClient();
    await credLogin(join(dir, "vaults/Ops/Cal.md"), { client, ask: async () => "s3cret", openBrowser: browser });

    assert.equal(oauth.seen.registered, null);
    assert.equal(oauth.seen.authorize.scope, "read write");
    assert.equal(oauth.seen.token.authorization, `Basic ${Buffer.from("my_client:s3cret").toString("base64")}`);
    const [, , body] = client.calls.find((c) => c[0] === "credential.create");
    assert.deepEqual(body.auth.refresh.token_endpoint_auth, { type: "client_secret_basic", client_secret: "s3cret" });
  } finally {
    await oauth.close();
  }
});

test("cred login explains what to add when the server won't register clients", async () => {
  const oauth = await fakeOAuth({ registration: false });
  try {
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, "vaults/Ops/Cal.md": credFile(oauth.url) });
    await assert.rejects(
      credLogin(join(dir, "vaults/Ops/Cal.md"), { client: fakeClient(), ask: noSecrets, openBrowser: () => assert.fail("no browser") }),
      /doesn't let apps register themselves[\s\S]*token_endpoint: http:\/\/127\.0\.0\.1:\d+\/auth\/token[\s\S]*supported: read write/,
    );
  } finally {
    await oauth.close();
  }
});

test("cred login creates nothing when no refresh token comes back", async () => {
  const oauth = await fakeOAuth({ refreshToken: null });
  try {
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, "vaults/Ops/Linear.md": credFile(oauth.url) });
    const client = fakeClient();
    await assert.rejects(credLogin(join(dir, "vaults/Ops/Linear.md"), { client, ask: noSecrets, openBrowser: browser }), /didn't return a refresh token/);
    assert.deepEqual(client.calls, []);
  } finally {
    await oauth.close();
  }
});

// cred create's menu, answered through piped input: one line per question.
const menu = (lines) => {
  const input = new PassThrough();
  input.end(lines.map((l) => `${l}\n`).join(""));
  return prompts(input, new PassThrough());
};

test("cred create asks for the vault, server and name, writes the file, then signs in", async () => {
  const oauth = await fakeOAuth();
  try {
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD });
    const client = fakeClient();
    // new vault's name, what it's for, server URL, credential name, how to get tokens
    await credCreate(dir, { client, io: menu(["Ops", "1", oauth.url, "Linear", "1"]), openBrowser: browser });

    const text = readFileSync(join(dir, "vaults/Ops/Linear.md"), "utf8");
    assert.match(text, new RegExp(`mcp_server_url: ${oauth.url}`));
    assert.match(text, /client_id: dyn_client/);
    assert.equal(client.calls.find((c) => c[0] === "credential.create")[2].auth.access_token, "at_1");
    assert.deepEqual(check(dir).errors, []);
  } finally {
    await oauth.close();
  }
});

test("cred create offers the agent's MCP servers, and asks for your own client where it must", async () => {
  const oauth = await fakeOAuth({ registration: false });
  try {
    const agent = AGENT_MD.replace("model: claude-opus-5-5\n", `model: claude-opus-5-5\nmcp_servers:\n  - type: url\n    name: calendar\n    url: ${oauth.url}\n`);
    const dir = instance({
      "agent.md": agent,
      "env.md": ENV_MD,
      "tools/calendar.md": "---\ntype: mcp_toolset\nmcp_server_name: calendar\n---\n",
      "vaults/Shared/vault.md": "---\n---\n",
    });
    const client = fakeClient();
    // vault, what it's for, server, name (default), tokens: write the file only, client ID, scopes, client auth
    await credCreate(dir, { client, io: menu(["1", "1", "1", "", "3", "my_client", "read write", "2"]), openBrowser: () => assert.fail("no browser") });

    const text = readFileSync(join(dir, "vaults/Shared/calendar.md"), "utf8");
    assert.equal(text, [
      "---", "auth:", "  type: mcp_oauth", `  mcp_server_url: ${oauth.url}`, "  refresh:",
      `    token_endpoint: ${oauth.origin}/auth/token`, "    client_id: my_client", "    scope: read write",
      "    token_endpoint_auth:", "      type: client_secret_basic", "---", "",
    ].join("\n"));
    assert.deepEqual(client.calls, []);
    assert.deepEqual(check(dir).errors, []);
  } finally {
    await oauth.close();
  }
});

test("cred create falls back to pasting tokens for a server with no OAuth sign-in", async () => {
  const oauth = await fakeOAuth({ path: "/elsewhere" });
  try {
    const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD });
    const client = fakeClient();
    // vault, what it's for, URL, name, tokens: paste, refreshable?, access token, expiry
    await credCreate(dir, { client, io: menu(["Ops", "1", `${oauth.origin}/mcp`, "Internal", "1", "n", "tok_1", ""]), openBrowser: () => assert.fail("no browser") });
    const [, , body] = client.calls.find((c) => c[0] === "credential.create");
    assert.deepEqual(body.auth, { type: "mcp_oauth", mcp_server_url: `${oauth.origin}/mcp`, access_token: "tok_1" });
  } finally {
    await oauth.close();
  }
});

test("cred deploy creates the credential an existing file describes", async () => {
  const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD, "vaults/Ops/Internal.md": credFile("https://example.com/mcp") });
  const client = fakeClient();
  // tokens: paste, access token, expiry
  await credDeploy(join(dir, "vaults/Ops/Internal.md"), { client, io: menu(["2", "tok_1", ""]), openBrowser: () => assert.fail("no browser") });
  assert.equal(client.calls.find((c) => c[0] === "credential.create")[2].auth.access_token, "tok_1");
  await assert.rejects(credCreate(join(dir, "vaults/Ops/Internal.md"), { client, io: menu([]) }), /run agentschema cred deploy/);
});

test("cred create adds an environment variable, and cred deploy only asks for its value", async () => {
  const env = ENV_MD.replace("type: limited\n", "type: limited\n    allowed_hosts:\n      - api.stripe.com\n");
  const dir = instance({ "agent.md": AGENT_MD, "env.md": env });
  const client = fakeClient();
  const lines = [];
  const noNetwork = async () => assert.fail("no network");
  // new vault, what it's for, variable, hosts, where it can appear, name (default), just write the file
  await credCreate(dir, { client, io: menu(["Ops", "2", "STRIPE_API_KEY", "api.stripe.com", "1", "", "2"]), fetch: noNetwork, log: (l) => lines.push(l) });
  const file = join(dir, "vaults/Ops/STRIPE_API_KEY.md");
  assert.equal(readFileSync(file, "utf8"), [
    "---", "auth:", "  type: environment_variable", "  secret_name: STRIPE_API_KEY", "  networking:", "    type: limited",
    "    allowed_hosts:", "      - api.stripe.com", "  injection_location:", "    header: true", "    body: false", "---", "",
  ].join("\n"));
  assert.deepEqual(client.calls, []);
  assert.match(lines.join("\n"), /agentschema cred deploy .*STRIPE_API_KEY\.md/);

  await credDeploy(file, { client, io: menu(["sk_test_1"]), openBrowser: () => assert.fail("no browser") });
  assert.equal(client.calls.find((c) => c[0] === "credential.create")[2].auth.secret_value, "sk_test_1");
});

test("cred create warns when the environment blocks the variable's host, and can set it right away", async () => {
  const dir = instance({ "agent.md": AGENT_MD, "env.md": ENV_MD });
  const client = fakeClient();
  const lines = [];
  // new vault, what it's for, variable, hosts, headers and body, name, paste the value, the value
  await credCreate(dir, { client, io: menu(["Ops", "2", "API_KEY", "api.example.com", "2", "Example", "1", "key_1"]), log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /warning: vaults\/Ops\/Example\.md: .*doesn't allow api\.example\.com/);
  const { auth } = client.calls.find((c) => c[0] === "credential.create")[2];
  assert.deepEqual(auth.injection_location, { header: true, body: true });
  assert.equal(auth.secret_value, "key_1");
});

test("the library can register under its own name, and manage credentials on a lock object", async () => {
  const { authorizationRequest, createCredential, deleteCredential, discover, exchangeCode, registerClient } = await import("../src/node.js");
  assert.equal(typeof discover, "function");
  assert.equal(typeof authorizationRequest, "function");
  assert.equal(typeof exchangeCode, "function");

  let registered;
  const fakeFetch = async (url, init) => {
    registered = JSON.parse(init.body);
    return new Response(JSON.stringify({ client_id: "abc" }), { status: 201 });
  };
  await registerClient("https://auth.example/register", "https://app.example/callback", { fetch: fakeFetch, clientName: "Agentbook" });
  assert.equal(registered.client_name, "Agentbook");
  await registerClient("https://auth.example/register", "https://app.example/callback", { fetch: fakeFetch });
  assert.equal(registered.client_name, "agentschema");

  const calls = [];
  const client = {
    beta: {
      vaults: {
        create: async (body) => (calls.push(["vault", body]), { id: "vlt_1" }),
        credentials: {
          create: async (vaultId, body) => (calls.push(["create", vaultId, body]), { id: "cred_1" }),
          delete: async (id, options) => calls.push(["delete", id, options]),
        },
      },
    },
  };
  const vault = { name: "secrets", path: "vaults/secrets", file: null };
  const cred = { file: "vaults/secrets/key.md", name: "key", data: { auth: { type: "environment_variable", secret_name: "API_KEY" } } };
  const lock = { version: 1, resources: {} };
  const saved = [];

  await createCredential({ lock, vault, cred, secrets: { secretValue: "shh" }, client, saveLock: async (next) => saved.push(structuredClone(next)) });
  assert.deepEqual(calls.map((c) => c[0]), ["vault", "create"]);
  assert.equal(calls[1][2].auth.secret_value, "shh");
  assert.equal(lock.resources["./vaults/secrets/key.md"].id, "cred_1");
  assert.equal(saved.length, 2);
  assert.ok(!JSON.stringify(saved).includes("shh"));

  await deleteCredential({ lock, cred, client });
  assert.deepEqual(calls.at(-1), ["delete", "cred_1", { vault_id: "vlt_1" }]);
  assert.equal(lock.resources["./vaults/secrets/key.md"], undefined);
  await deleteCredential({ lock, cred, client });
  assert.equal(calls.filter((c) => c[0] === "delete").length, 1);
});
