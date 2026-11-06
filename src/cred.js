import { writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { check } from "./check.js";
import { DeployError, call, openLock, retrieve } from "./deploy.js";
import { LOCK_FILE, hashBody, writeLock } from "./lock.js";
import { readFolder, updateFrontmatter } from "./folder.js";
import { listedMcpToolset } from "./mcp.js";
import { authorizationRequest, discover, exchangeCode, registerClient, startCallbackServer } from "./oauth.js";
import {
  ENV_VAR, VAULTS_DIR, VAULT_FILE, changedImmutableFields, credentialCreateBody, credentialKey, credentialSettings,
  secretsNeeded, vaultBody, vaultKey,
} from "../lib/vaults.js";

// Finds the agent folder and the credential a path like my-agent/vaults/Ops/slack.md names.
export function locate(path) {
  const file = resolve(path);
  const vaultDir = dirname(file);
  const dir = dirname(dirname(vaultDir));
  if (basename(dirname(vaultDir)) !== VAULTS_DIR || !file.endsWith(".md") || basename(file) === VAULT_FILE) {
    throw new DeployError(`${path}: not a credential file; expected a path like my-agent/${VAULTS_DIR}/<vault>/<credential>.md`);
  }

  const { errors, instance } = check(dir);
  if (errors.length > 0) throw new DeployError(`check failed:\n  ${errors.join("\n  ")}`);
  const rel = relative(dir, file).split(sep).join("/");
  const vault = instance.vaults.find((v) => v.name === basename(vaultDir));
  const cred = vault?.credentials.find((c) => c.file === rel);
  if (!cred) throw new DeployError(`${path}: no such credential file`);
  return { dir, vault, cred };
}

// Creates the credential a file describes from the secrets you paste, asking for them with
// `ask(question, { secret })`. The secrets go straight to the vault and are never written to
// disk. Creates the vault first if it hasn't been deployed.
export async function credPaste(path, { client, ask, log = () => {} }) {
  const { dir, vault, cred } = locate(path);
  const lock = openLock(dir, client);
  const vaultEntry = lock.resources[vaultKey(vault)];
  const existing = lock.resources[credentialKey(cred)];
  if (existing && existing.vault_id === vaultEntry?.id) {
    throw new DeployError(
      `${cred.file} was already created (${existing.id}). To replace its secrets, delete it with ` +
        `\`agentschema cred delete ${path}\` and create it again.`,
    );
  }

  const needs = secretsNeeded(cred);
  const required = async (question) => {
    const answer = (await ask(question, { secret: true })).trim();
    if (!answer) throw new DeployError(`${question.replace(/:\s*$/, "")} is required`);
    return answer;
  };
  if (cred.data.auth.type === ENV_VAR) {
    const secretValue = await required(`Value of ${cred.data.auth.secret_name}: `);
    return createCredential({ lock, vault, cred, secrets: { secretValue }, client, saveLock: (next) => writeLock(dir, next), log });
  }
  const secrets = { accessToken: await required("Access token: ") };
  const expiresAt = (await ask("Access token expires at (ISO 8601, e.g. 2026-12-31T23:59:59Z; blank if unknown): ", { secret: false })).trim();
  if (expiresAt) {
    if (Number.isNaN(Date.parse(expiresAt))) throw new DeployError(`"${expiresAt}" isn't a date and time`);
    secrets.expiresAt = new Date(expiresAt).toISOString();
  }
  if (needs.refreshToken) secrets.refreshToken = await required("Refresh token: ");
  if (needs.clientSecret) secrets.clientSecret = await required("Client secret: ");

  return createCredential({ lock, vault, cred, secrets, client, saveLock: (next) => writeLock(dir, next), log });
}

// Creates a credential with its secrets, creating its vault first if needed, records it in the
// lock, and asks the API to try it. `secrets` are what credentialCreateBody takes. Works on a lock
// object, so a host can keep it wherever it likes, and `saveLock` may be async.
export async function createCredential({ lock, vault, cred, secrets, client, saveLock = () => {}, log = () => {} }) {
  let vaultId = lock.resources[vaultKey(vault)]?.id;
  if (!vaultId) {
    const body = vaultBody(vault);
    const created = await call({ file: vault.path, kind: "vault" }, () => client.beta.vaults.create(body));
    vaultId = created.id;
    lock.resources[vaultKey(vault)] = { kind: "vault", id: vaultId, hash: hashBody(body) };
    await saveLock(lock);
    log(`created   vault ${vaultId}`);
  }

  const created = await call({ file: cred.file, kind: "credential" }, () =>
    client.beta.vaults.credentials.create(vaultId, credentialCreateBody(cred, secrets)),
  );
  lock.resources[credentialKey(cred)] = { kind: "credential", id: created.id, vault_id: vaultId, hash: hashBody(credentialSettings(cred)) };
  await saveLock(lock);
  log(`created   credential ${created.id}`);

  if (cred.data.auth.type === ENV_VAR) return created;

  // Best effort: ask the API to try the credential against the MCP server.
  try {
    const validation = await client.beta.vaults.credentials.mcpOAuthValidate(created.id, { vault_id: vaultId });
    if (validation.status === "valid") log("checked   the MCP server accepted the credential");
    else log(`warning: the API couldn't confirm the credential works (${validation.status}); check the tokens`);
  } catch {
    // Validation is only a convenience; the credential exists either way.
  }
  return created;
}

// Signs in to the credential's MCP server in the browser, then creates the credential with the
// tokens, or replaces the tokens of the one that exists. Endpoints come from the server's OAuth
// metadata. The OAuth client is the file's `auth.refresh.client_id`; without a refresh block,
// agentschema registers itself as a client, if the server allows it, and writes the refresh
// block into the file. Tokens go straight to the vault and are never written to disk.
export async function credLogin(path, { client, ask, openBrowser, port = 0, fetch = globalThis.fetch, log = () => {} }) {
  let located = locate(path);
  const { auth } = located.cred.data;
  if (auth.type === ENV_VAR) {
    throw new DeployError(`${located.cred.file} is an environment variable, so there's nothing to sign in to; set its value with agentschema cred deploy ${path}`);
  }
  let refresh = auth.refresh ?? null;

  log(`Looking up the sign-in for ${auth.mcp_server_url}…`);
  const server = await discover(auth.mcp_server_url, { fetch });
  if (server.codeChallengeMethods && !server.codeChallengeMethods.includes("S256")) {
    throw new DeployError(`${server.issuer} doesn't support PKCE with S256, which agentschema needs to sign in`);
  }

  const callback = await startCallbackServer(Number(port));
  try {
    let clientId, clientSecret = null, authMethod, tokenEndpoint;
    if (refresh) {
      ({ client_id: clientId, token_endpoint: tokenEndpoint } = refresh);
      authMethod = refresh.token_endpoint_auth.type;
      if (authMethod !== "none") clientSecret = await required(ask, "Client secret: ");
    } else if (server.registrationEndpoint) {
      ({ clientId, clientSecret, authMethod } = await registerClient(server.registrationEndpoint, callback.redirectUri, { fetch }));
      tokenEndpoint = server.tokenEndpoint;
      log(`Registered agentschema as an OAuth client (${clientId}).`);
    } else {
      throw new DeployError(noClientMessage(located.cred, server, callback.redirectUri));
    }

    const resource = refresh ? (refresh.resource ?? null) : (server.resource ?? auth.mcp_server_url);
    const request = authorizationRequest({
      authorizationEndpoint: server.authorizationEndpoint,
      issuer: server.issuer,
      clientId,
      redirectUri: callback.redirectUri,
      scope: refresh?.scope,
      resource,
    });
    log(`Opening your browser to sign in. If it doesn't open, go to:\n  ${request.url}`);
    openBrowser(request.url);
    const code = await callback.waitForCode(request.state);
    const tokens = await exchangeCode(
      { tokenEndpoint, code, verifier: request.verifier, redirectUri: callback.redirectUri, clientId, clientSecret, authMethod, resource },
      { fetch },
    );
    if (!tokens.refreshToken) {
      throw new DeployError(
        "the server didn't return a refresh token, so the credential would stop working when the access token expires. Nothing was created.",
      );
    }

    // A client agentschema registered: record it in the file, since it's part of the credential.
    if (!refresh) {
      refresh = { token_endpoint: tokenEndpoint, client_id: clientId };
      if (tokens.scope) refresh.scope = tokens.scope;
      if (resource) refresh.resource = resource;
      refresh.token_endpoint_auth = { type: authMethod };
      updateFrontmatter(resolve(path), (doc) => doc.setIn(["auth", "refresh"], doc.createNode(refresh)));
      log(`Added auth.refresh to ${located.cred.file}.`);
      located = locate(path);
    }

    const secrets = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshToken: tokens.refreshToken, clientSecret };
    const { dir, vault, cred } = located;
    await listToolsInFile(dir, auth.mcp_server_url, tokens.accessToken, { fetch, log });
    const lock = openLock(dir, client);
    const existing = lock.resources[credentialKey(cred)];
    if (existing && existing.vault_id === lock.resources[vaultKey(vault)]?.id) {
      return replaceTokens({ dir, lock, cred, entry: existing }, secrets, { client, log });
    }
    return createCredential({ lock, vault, cred, secrets, client, saveLock: (next) => writeLock(dir, next), log });
  } finally {
    await callback.close();
  }
}

// Now that the server will say what it offers, lists its tools in their file.
async function listToolsInFile(dir, url, token, { fetch, log }) {
  const listed = await listedMcpToolset(readFolder(dir), url, { fetch, token });
  if (!listed) return;
  writeFileSync(join(dir, listed.path), listed.text);
  log(`Listed the server's tools in ${listed.path}.`);
}

async function required(ask, question) {
  const answer = (await ask(question, { secret: true })).trim();
  if (!answer) throw new DeployError(`${question.replace(/:\s*$/, "")} is required`);
  return answer;
}

// Puts the tokens from a new sign-in into an existing credential.
async function replaceTokens({ cred, entry }, secrets, { client, log }) {
  const step = { file: cred.file, kind: "credential", key: credentialKey(cred), entry };
  const remote = await retrieve(step, () => client.beta.vaults.credentials.retrieve(entry.id, { vault_id: entry.vault_id }));
  const changed = changedImmutableFields(cred, remote.auth);
  if (changed.length > 0) {
    throw new DeployError(
      `${cred.file}: ${changed.map((f) => `\`auth.${f}\``).join(", ")} changed since the credential was created. ` +
        "Delete it with `agentschema cred delete`, then sign in again.",
    );
  }
  const { auth } = cred.data;
  const body = {
    vault_id: entry.vault_id,
    auth: { type: auth.type, access_token: secrets.accessToken, expires_at: secrets.expiresAt, refresh: { refresh_token: secrets.refreshToken } },
  };
  const method = auth.refresh.token_endpoint_auth.type;
  if (method !== "none") body.auth.refresh.token_endpoint_auth = { type: method, client_secret: secrets.clientSecret };
  const updated = await call(step, () => client.beta.vaults.credentials.update(entry.id, body));
  log(`updated   credential ${updated.id} with the new tokens`);
  return updated;
}

// What to do when the server won't register agentschema: bring your own OAuth client.
function noClientMessage(cred, server, redirectUri) {
  const scopes = server.scopesSupported.length > 0 ? `\n    scope: ${server.scopesSupported[0]}   # supported: ${server.scopesSupported.join(" ")}` : "";
  return (
    `${server.issuer} doesn't let apps register themselves, so sign-in needs your own OAuth client. ` +
    `Create one with the provider, allowing the redirect URI ${redirectUri.replace(/:\d+\//, ":<port>/")} ` +
    `(pass the same --port to cred login), then add this to ${cred.file}:\n\n` +
    `  refresh:\n    token_endpoint: ${server.tokenEndpoint}\n    client_id: "…"${scopes}\n    token_endpoint_auth:\n      type: client_secret_post`
  );
}

// Permanently deletes the credential a file describes and removes it from claude-lock.json.
// The file itself stays, so `cred deploy` can create it again.
export async function credDelete(path, { client, confirm, log = () => {} }) {
  const { dir, cred } = locate(path);
  const lock = openLock(dir, client);
  const entry = lock.resources[credentialKey(cred)];
  if (!entry) throw new DeployError(`${cred.file} has no credential in ${LOCK_FILE}; there's nothing to delete`);

  if (!(await confirm(`Delete credential "${cred.name}" (${entry.id})? Its tokens are gone for good.`))) {
    log("Cancelled.");
    return;
  }
  await deleteCredential({ lock, cred, client, saveLock: (next) => writeLock(dir, next) });
  log(`deleted   credential ${entry.id}`);
}

// Permanently deletes a credential, if it has one, and removes it from the lock. One that's already
// gone counts as deleted. Works on a lock object, like createCredential.
export async function deleteCredential({ lock, cred, client, saveLock = () => {} }) {
  const entry = lock.resources[credentialKey(cred)];
  if (!entry) return;
  try {
    await client.beta.vaults.credentials.delete(entry.id, { vault_id: entry.vault_id });
  } catch (err) {
    if (!(err instanceof Anthropic.APIError && err.status === 404)) {
      throw new DeployError(`couldn't delete ${entry.id} (${err.status ?? "network error"}): ${err.error?.error?.message ?? err.message}`);
    }
  }
  delete lock.resources[credentialKey(cred)];
  await saveLock(lock);
}
