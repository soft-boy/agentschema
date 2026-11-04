import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DeployError } from "./deploy.js";

// OAuth for MCP servers, as the MCP authorization spec describes it: find the server's
// authorization server from its URL, then sign in through the browser with the authorization
// code flow and PKCE, receiving the code on a local port.

// A DeployError, so the CLI reports it like any other failure.
export class OAuthError extends DeployError {}

const GOOGLE = "accounts.google.com";

// Finds the OAuth endpoints for an MCP server from its URL alone.
// Returns { resource, scopesSupported, issuer, authorizationEndpoint, tokenEndpoint,
// registrationEndpoint, codeChallengeMethods }.
export async function discover(serverUrl, { fetch = globalThis.fetch } = {}) {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, "");

  // Protected resource metadata (RFC 9728): which authorization server the MCP server trusts.
  const resourceMeta =
    (path && (await getJSON(`${url.origin}/.well-known/oauth-protected-resource${path}`, fetch))) ||
    (await getJSON(`${url.origin}/.well-known/oauth-protected-resource`, fetch));
  const issuer = resourceMeta?.authorization_servers?.[0] ?? url.origin;

  // Authorization server metadata (RFC 8414), or OpenID Connect discovery, which Google uses.
  const as = new URL(issuer);
  const asPath = as.pathname.replace(/\/$/, "");
  const candidates = [
    `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${as.origin}/.well-known/openid-configuration${asPath}`,
    ...(asPath ? [`${as.origin}${asPath}/.well-known/openid-configuration`] : []),
  ];
  let meta = null;
  for (const candidate of candidates) {
    meta = await getJSON(candidate, fetch);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }
  if (!meta) {
    throw new OAuthError(`couldn't find the OAuth sign-in for ${serverUrl}: ${issuer} publishes no authorization server metadata`);
  }

  return {
    resource: resourceMeta?.resource ?? null,
    scopesSupported: resourceMeta?.scopes_supported ?? meta.scopes_supported ?? [],
    issuer: meta.issuer ?? issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint ?? null,
    codeChallengeMethods: meta.code_challenge_methods_supported ?? null,
  };
}

async function getJSON(url, fetch) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Starts the local server the browser is sent back to after signing in.
// Returns { redirectUri, waitForCode(state, timeoutMs), close() }.
export async function startCallbackServer(port = 0) {
  let deliver;
  const received = new Promise((resolve) => (deliver = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><title>agentschema</title><body style="font:16px system-ui;margin:4em auto;max-width:30em">` +
        (error ? `<h1>Sign-in failed</h1><p>${escape(error)}. Check the terminal.</p>` : "<h1>Signed in</h1><p>You can close this tab and go back to the terminal.</p>") +
        "</body>",
    );
    deliver(url.searchParams);
  });
  await new Promise((resolve, reject) => {
    server.once("error", (err) => reject(new OAuthError(`couldn't listen on 127.0.0.1:${port}: ${err.message}`)));
    server.listen(port, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  return {
    redirectUri,
    async waitForCode(state, timeoutMs = 5 * 60_000) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new OAuthError("timed out waiting for the browser sign-in")), timeoutMs);
      });
      try {
        const params = await Promise.race([received, timeout]);
        const error = params.get("error");
        if (error) {
          const detail = params.get("error_description");
          throw new OAuthError(`sign-in failed: ${error}${detail ? ` (${detail})` : ""}`);
        }
        if (params.get("state") !== state) throw new OAuthError("sign-in failed: the response's state didn't match");
        const code = params.get("code");
        if (!code) throw new OAuthError("sign-in failed: no authorization code came back");
        return code;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Registers agentschema as an OAuth client (RFC 7591), for servers that allow it.
// Returns { clientId, clientSecret, authMethod }.
export async function registerClient(registrationEndpoint, redirectUri, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "agentschema",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    throw new OAuthError(`couldn't register a client at ${registrationEndpoint} (${res.status}): ${body.error_description ?? body.error ?? "no client_id in the response"}`);
  }
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret ?? null,
    authMethod: body.token_endpoint_auth_method ?? (body.client_secret ? "client_secret_post" : "none"),
  };
}

// The URL to send the browser to, and the PKCE verifier and state to finish with.
export function authorizationRequest({ authorizationEndpoint, issuer, clientId, redirectUri, scope, resource }) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const url = new URL(authorizationEndpoint);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  };
  if (scope) params.scope = scope;
  if (resource) params.resource = resource;
  // Google only issues a refresh token for offline access, and only on a fresh consent.
  if (new URL(issuer).host === GOOGLE) Object.assign(params, { access_type: "offline", prompt: "consent" });
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { url: url.toString(), verifier, state };
}

// Trades the authorization code for tokens.
// Returns { accessToken, refreshToken, expiresAt, scope }.
export async function exchangeCode({ tokenEndpoint, code, verifier, redirectUri, clientId, clientSecret, authMethod, resource }, { fetch = globalThis.fetch } = {}) {
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  if (resource) form.set("resource", resource);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (authMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", clientId);
    if (authMethod === "client_secret_post") form.set("client_secret", clientSecret);
  }

  const res = await fetch(tokenEndpoint, { method: "POST", headers, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new OAuthError(`the token endpoint refused the sign-in (${res.status}): ${body.error_description ?? body.error ?? "no access token in the response"}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
    scope: body.scope ?? null,
  };
}

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
