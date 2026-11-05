import { comparePaths, isIgnoredPath, textOf } from "./files.js";
import { FileError, parseMarkdown } from "./markdown.js";

export const VAULTS_DIR = "vaults";
export const VAULT_FILE = "vault.md";
export const MCP_OAUTH = "mcp_oauth";
export const ENV_VAR = "environment_variable";
export const CREDENTIAL_TYPES = [MCP_OAUTH, ENV_VAR];
export const TOKEN_ENDPOINT_AUTH = ["none", "client_secret_basic", "client_secret_post"];

// Fields that hold secrets or short-lived values. They never go in a file: `cred deploy`
// asks for them and sends them straight to the vault.
export const SECRET_FIELDS = {
  [MCP_OAUTH]: [
    ["access_token"],
    ["expires_at"],
    ["refresh", "refresh_token"],
    ["refresh", "token_endpoint_auth", "client_secret"],
  ],
  [ENV_VAR]: [["secret_value"]],
};

// Fields the API won't change on an existing credential. Changing one in a file is an error;
// delete the credential and create it again.
export const IMMUTABLE_FIELDS = {
  [MCP_OAUTH]: [
    ["type"],
    ["mcp_server_url"],
    ["refresh"], // adding or removing the refresh block
    ["refresh", "token_endpoint"],
    ["refresh", "client_id"],
    ["refresh", "resource"],
    ["refresh", "token_endpoint_auth", "type"],
  ],
  [ENV_VAR]: [["type"], ["secret_name"]],
};

// Reads vaults/: each folder is a vault named after the folder, holding an optional vault.md
// and one .md file per credential, named after the file. Vaults are sorted by name, which is
// the order `run` attaches them in. No vaults/ folder means no vaults.
// Returns { vaults, errors }; a file that can't be parsed has an entry in errors.
export function readVaults(files) {
  if (VAULTS_DIR in files) return { vaults: [], errors: [`${VAULTS_DIR}: not a directory`] };

  const vaults = new Map();
  const errors = [];
  const parse = (file) => {
    try {
      return parseMarkdown(textOf(files[file]), file);
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
      return null;
    }
  };

  const reportedFolders = new Set();
  const paths = Object.keys(files)
    .filter((path) => path.startsWith(`${VAULTS_DIR}/`) && !isIgnoredPath(path))
    .sort(comparePaths);
  for (const file of paths) {
    const [, vaultName, itemName, ...rest] = file.split("/");
    if (itemName === undefined) {
      if (vaultName.endsWith(".md")) errors.push(`${file}: each vault is a folder; put credential files inside one`);
      continue;
    }

    const path = `${VAULTS_DIR}/${vaultName}`;
    if (!vaults.has(vaultName)) vaults.set(vaultName, { name: vaultName, path, file: null, credentials: [] });
    const vault = vaults.get(vaultName);
    if (rest.length > 0) {
      const folder = `${path}/${itemName}`;
      if (!reportedFolders.has(folder)) errors.push(`${folder}: a vault holds credential files, not folders`);
      reportedFolders.add(folder);
    } else if (itemName === VAULT_FILE) {
      vault.file = parse(file);
    } else if (itemName.endsWith(".md")) {
      const parsed = parse(file);
      if (parsed) vault.credentials.push({ file, name: itemName.slice(0, -".md".length), vault: vaultName, ...parsed });
    }
  }
  return { vaults: [...vaults.values()], errors };
}

// The lock file keys for a vault and a credential.
export const vaultKey = (vault) => `./${vault.path}`;
export const credentialKey = (cred) => `./${cred.file}`;

// The body sent to POST /v1/vaults: the folder name and vault.md's metadata.
export function vaultBody(vault) {
  const body = { display_name: vault.name };
  if (vault.file?.data.metadata !== undefined) body.metadata = vault.file.data.metadata;
  return body;
}

// A credential's settings from its file: everything but the secrets. This is what's hashed
// into the lock, and what deploy keeps in sync.
export function credentialSettings(cred) {
  const body = { display_name: cred.name, auth: structuredClone(cred.data.auth) };
  if (cred.data.metadata !== undefined) body.metadata = cred.data.metadata;
  return body;
}

// The body sent to create a credential: its settings plus the secrets `cred deploy` asked for.
export function credentialCreateBody(cred, { accessToken, expiresAt, refreshToken, clientSecret, secretValue }) {
  const body = credentialSettings(cred);
  if (body.auth.type === ENV_VAR) {
    body.auth.secret_value = secretValue;
    return body;
  }
  body.auth.access_token = accessToken;
  if (expiresAt) body.auth.expires_at = expiresAt;
  if (body.auth.refresh) {
    body.auth.refresh.refresh_token = refreshToken;
    if (body.auth.refresh.token_endpoint_auth?.type !== "none") body.auth.refresh.token_endpoint_auth.client_secret = clientSecret;
  }
  return body;
}

// Which secrets a credential file needs when it's created.
export function secretsNeeded(cred) {
  const refresh = cred.data.auth?.refresh;
  return {
    refreshToken: Boolean(refresh),
    clientSecret: Boolean(refresh) && refresh.token_endpoint_auth?.type !== "none",
  };
}

// The immutable fields whose value in the file differs from the deployed credential's.
export function changedImmutableFields(cred, remoteAuth) {
  const local = cred.data.auth ?? {};
  const changed = [];
  for (const path of IMMUTABLE_FIELDS[local.type] ?? []) {
    const a = get(local, path);
    const b = get(remoteAuth ?? {}, path);
    const differs = path.length === 1 && path[0] === "refresh" ? Boolean(a) !== Boolean(b) : (a ?? null) !== (b ?? null);
    if (differs) changed.push(path.join("."));
  }
  return changed;
}

export const get = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
