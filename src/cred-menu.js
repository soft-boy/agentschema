import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { check } from "./check.js";
import { credLogin, credPaste, locate } from "./cred.js";
import { DeployError } from "./deploy.js";
import { discover } from "./oauth.js";
import { ENV_VAR, TOKEN_ENDPOINT_AUTH, VAULTS_DIR, VAULT_FILE } from "../lib/vaults.js";

const SIGN_IN = "Sign in with the browser";
const PASTE = "Paste the tokens";
const PASTE_VALUE = "Paste the value";
const LATER = "Just write the file";
const NEW_VAULT = "New vault…";
const OTHER_URL = "Another URL…";
const FOR_MCP = "An MCP server's sign-in (OAuth)";
const FOR_ENV_VAR = "An environment variable (an API key, say)";
const HEADERS_ONLY = "Request headers only";
const HEADERS_AND_BODY = "Headers and body";

// `cred create`: asks which vault the credential goes in and what it's for, writes its file,
// then gets its secrets and creates it, unless you'd rather do that later with `cred deploy`.
export async function credCreate(dir = ".", options) {
  const { io, fetch = globalThis.fetch, log = () => {} } = options;
  if (dir.endsWith(".md")) {
    throw new DeployError(`cred create takes the agent folder; to create the credential ${dir} describes, run agentschema cred deploy ${dir}`);
  }
  const { file, method } = await writeCredentialFile(dir, { io, fetch, log });
  if (method === LATER) {
    log(`\nCreate the credential in Anthropic when you're ready with:\n  agentschema cred deploy ${file}`);
    return null;
  }
  return getTokens(file, method, options);
}

// `cred deploy`: creates the credential a file describes in Anthropic, asking whether to sign
// in for its tokens or paste them.
export async function credDeploy(file, options) {
  if (!existsSync(file)) throw new DeployError(`${file}: no such file; to write a new credential file, run agentschema cred create`);
  const { cred } = locate(file);
  // An environment variable has no sign-in, so there's only its value to ask for.
  const method = cred.data.auth.type === ENV_VAR ? PASTE : await options.io.select("How do you want to get its tokens?", [SIGN_IN, PASTE], SIGN_IN);
  return getTokens(file, method, options);
}

// Tokens come from signing in (`cred login`) or from pasting them (`credPaste`).
function getTokens(file, method, { client, io, openBrowser, port = 0, fetch = globalThis.fetch, log = () => {} }) {
  const ask = (question, { secret }) => (secret ? io.secret(question.trim()) : io.text(question.trim()));
  return method === SIGN_IN
    ? credLogin(file, { client, ask, openBrowser, port, fetch, log })
    : credPaste(file, { client, ask, log });
}

// Asks about the credential, and writes vaults/<vault>/<name>.md. Returns { file, method }.
async function writeCredentialFile(dir, { io, fetch, log }) {
  const { errors, instance } = check(dir);
  if (!instance) throw new DeployError(`${dir} isn't an agent folder:\n  ${errors.join("\n  ")}`);
  if (errors.length > 0) throw new DeployError(`check failed:\n  ${errors.join("\n  ")}`);

  // The vault: an existing one, or a new folder.
  const names = instance.vaults.map((v) => v.name);
  let vaultName = names.length > 0 ? await io.select("Which vault?", [...names, NEW_VAULT], names[0]) : NEW_VAULT;
  if (vaultName === NEW_VAULT) {
    vaultName = await io.text("New vault's name?", names.includes("Shared") ? "" : "Shared", {
      validate: (name) => fileName(name, "vault") ?? (names.includes(name) ? `There's already a vault called ${name}` : null),
    });
  }
  const vault = instance.vaults.find((v) => v.name === vaultName);
  const vaultDir = join(dir, VAULTS_DIR, vaultName);
  const kind = await io.select("What is it for?", [FOR_MCP, FOR_ENV_VAR], FOR_MCP);
  const { name, auth, method } = kind === FOR_ENV_VAR
    ? await envVarCredential({ io, vault, vaultName, vaultDir })
    : await mcpCredential({ io, instance, vault, vaultName, vaultDir, fetch, log });

  mkdirSync(vaultDir, { recursive: true });
  const file = join(vaultDir, `${name}.md`);
  writeFileSync(file, `---\n${stringify({ auth })}---\n`);
  log(`Wrote ${file}`);

  const rel = `${VAULTS_DIR}/${vaultName}/${name}.md`;
  for (const warning of check(dir).warnings.filter((w) => w.startsWith(rel))) log(`warning: ${warning}`);
  return { file, method };
}

// An environment variable: its name, the hosts that may receive it, and where it can appear.
async function envVarCredential({ io, vault, vaultName, vaultDir }) {
  const taken = new Set(vault?.credentials.map((c) => c.data.auth?.secret_name) ?? []);
  const secretName = await io.text("Variable name? (like STRIPE_API_KEY)", "", {
    validate: (n) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return "Use letters, digits and _, not starting with a digit";
      return taken.has(n) ? `${vaultName} already sets ${n}` : null;
    },
  });
  const hosts = await io.text("Which hosts may it be sent to? (like api.stripe.com; separate several with spaces)", "", {
    validate: (h) => {
      const list = h.split(/[\s,]+/).filter(Boolean);
      if (list.length === 0) return "List at least one host";
      return list.some((x) => x.includes("/")) ? "Enter host names, without https:// or a path" : null;
    },
  });
  const where = await io.select("Where in a request can it appear?", [HEADERS_ONLY, HEADERS_AND_BODY], HEADERS_ONLY);
  const name = await io.text("Credential name?", secretName, {
    validate: (n) => fileName(n, "credential") ?? (existsSync(join(vaultDir, `${n}.md`)) ? `${vaultName}/${n}.md already exists` : null),
  });
  const method = await io.select("How do you want to set its value?", [PASTE_VALUE, LATER], PASTE_VALUE);
  return {
    name,
    method: method === PASTE_VALUE ? PASTE : LATER,
    auth: {
      type: ENV_VAR,
      secret_name: secretName,
      networking: { type: "limited", allowed_hosts: hosts.split(/[\s,]+/).filter(Boolean) },
      injection_location: { header: true, body: where === HEADERS_AND_BODY },
    },
  };
}

// An MCP server's sign-in: the server, a name, and how its tokens will be fetched.
async function mcpCredential({ io, instance, vault, vaultName, vaultDir, fetch, log }) {
  const taken = new Set(vault?.credentials.map((c) => c.data.auth?.mcp_server_url) ?? []);

  // The MCP server: one agent.md declares, or any URL.
  const servers = (instance.agent.data.mcp_servers ?? []).filter((s) => typeof s?.url === "string" && !taken.has(s.url));
  const label = (s) => `${s.name ?? s.url} (${s.url})`;
  let url = OTHER_URL;
  if (servers.length > 0) {
    const picked = await io.select("Which MCP server is it for?", [...servers.map(label), OTHER_URL], label(servers[0]));
    url = servers.find((s) => label(s) === picked)?.url ?? OTHER_URL;
  }
  if (url === OTHER_URL) {
    url = await io.text("MCP server URL?", "", {
      validate: (u) => (!/^https?:\/\/\S+$/.test(u) ? "Enter an http(s) URL" : taken.has(u) ? `${vaultName} already has a credential for ${u}` : null),
    });
  }

  const suggested = servers.find((s) => s.url === url)?.name ?? serviceName(url);
  const name = await io.text("Credential name?", suggested, {
    validate: (n) => fileName(n, "credential") ?? (existsSync(join(vaultDir, `${n}.md`)) ? `${vaultName}/${n}.md already exists` : null),
  });

  // How its tokens will be fetched decides what the file needs.
  log(`Looking up the sign-in for ${url}…`);
  const server = await discover(url, { fetch }).catch(() => null);
  if (!server) log("It doesn't publish an OAuth sign-in, so you'll paste its tokens.");
  const method = await io.select("How do you want to get its tokens?", server ? [SIGN_IN, PASTE, LATER] : [PASTE, LATER], server ? SIGN_IN : PASTE);

  const auth = { type: "mcp_oauth", mcp_server_url: url };
  if (server && method !== PASTE) {
    // Signing in registers agentschema as a client where the server allows it; elsewhere, it
    // needs your own OAuth client.
    if (!server.registrationEndpoint) {
      log(`${server.issuer} doesn't let apps register themselves, so sign-in needs your own OAuth client.`);
      log("Create one with the provider, allowing the redirect URI http://127.0.0.1:<port>/callback.");
      auth.refresh = await refreshBlock(io, server, { tokenEndpoint: server.tokenEndpoint });
    }
  } else if (method === PASTE && (await io.confirm("Can the access token be refreshed? (needs a refresh token and the OAuth client's details)", Boolean(server)))) {
    auth.refresh = await refreshBlock(io, server, {});
  }

  return { name, auth, method };
}

// The client details for the file's auth.refresh block.
async function refreshBlock(io, server, { tokenEndpoint }) {
  const refresh = {};
  refresh.token_endpoint = tokenEndpoint ?? (await io.text("Token endpoint?", server?.tokenEndpoint ?? "", {
    validate: (u) => (/^https?:\/\/\S+$/.test(u) ? null : "Enter an http(s) URL"),
  }));
  refresh.client_id = await io.text("OAuth client ID?", "", { validate: (id) => (id ? null : "The client ID is required") });
  const supported = server?.scopesSupported ?? [];
  const hint = supported.length > 0 ? ` (supported: ${supported.slice(0, 6).join(" ")}${supported.length > 6 ? " …" : ""})` : "";
  const scope = await io.text(`Scopes, separated by spaces${hint}?`, "");
  if (scope) refresh.scope = scope;
  const type = await io.select("How does the client authenticate to the token endpoint?", TOKEN_ENDPOINT_AUTH, "client_secret_post");
  refresh.token_endpoint_auth = { type };
  return refresh;
}

// Why a vault or credential name can't be a file name, or nothing when it can.
function fileName(name, what) {
  if (!name) return `The ${what} needs a name`;
  if (/[/\\]/.test(name) || name.startsWith(".")) return `A ${what} name can't contain / or start with .`;
  if (what === "credential" && `${name}.md` === VAULT_FILE) return "vault is reserved for vault.md";
  if (name.length > 255) return `A ${what} name can be at most 255 characters`;
  return null;
}

// "Linear" for https://mcp.linear.app/mcp: the host's main label, capitalized.
export function serviceName(url) {
  const labels = new URL(url).hostname.split(".").filter((l) => !["mcp", "api", "www"].includes(l));
  let main = labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? "credential");
  // A cloud's shared domain names the cloud, not the service: calendarmcp.googleapis.com.
  if (["googleapis", "amazonaws", "azure", "azurewebsites", "cloudflare", "workers"].includes(main) && labels.length > 2) {
    main = labels[0].replace(/-?mcp$/, "") || main;
  }
  return main.replace(/^./, (c) => c.toUpperCase());
}
