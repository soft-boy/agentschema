# `vaults/`

Credentials the agent uses, without their secrets. Each folder is a [vault](https://platform.claude.com/docs/en/managed-agents/vaults), named after the folder, and each `.md` file in it is a credential, named after the file. A session gets every deployed vault.

```
vaults/
└── secrets/
    ├── vault.md       # optional settings for the vault
    ├── linear.md      # an MCP server's sign-in
    └── stripe.md      # an API key, as an environment variable
```

Files never hold secrets, so they're safe to commit. Secrets go straight to the vault, where they're write-only: the API never returns them, even to you. That's why [channels](channels.md), whose secrets a server must read back, don't use vaults.

## Vaults

A vault's name can be up to 255 characters, and it holds up to 20 credentials. It can hold one credential per MCP server, and one per environment variable. A nested folder, or a `.md` file directly in `vaults/`, is an error.

`vault.md` is optional, and only takes `metadata`, up to 16 keys of text. Any other field gets a warning, and isn't sent, although the warning currently says it is:

```markdown path=vaults/secrets/vault.md
---
metadata:
  team: support
---
```

## Credentials

Every credential file has `auth`, and may have `metadata`. `display_name` is refused, because the file name is the credential's name, up to 255 characters. Any other top-level field gets a warning, and isn't sent, although the warning currently says it is. An unknown field inside `auth` also gets a warning, and that one is sent.

### `mcp_oauth`

A sign-in to an MCP server.

```markdown path=vaults/secrets/linear.md
---
auth:
  type: mcp_oauth
  mcp_server_url: https://mcp.linear.app/mcp
---
```

With `auth.refresh`, the API can refresh the access token by itself. `cred login` writes this block for you when it can register itself with the server:

```markdown path=vaults/secrets/github.md
---
auth:
  type: mcp_oauth
  mcp_server_url: https://mcp.example.com/mcp
  refresh:
    token_endpoint: https://auth.example.com/token
    client_id: "abc123"
    scope: read write
    resource: https://mcp.example.com/mcp
    token_endpoint_auth:
      type: client_secret_post
---
```

| Field | Rules |
|---|---|
| `auth.mcp_server_url` | Required. An http(s) URL |
| `auth.refresh.token_endpoint` | Required with `refresh`. An http(s) URL |
| `auth.refresh.client_id` | Required with `refresh`. Text, so quote it if it looks like a number |
| `auth.refresh.scope` | Text |
| `auth.refresh.resource` | Text |
| `auth.refresh.token_endpoint_auth.type` | Required with `refresh`. `none`, `client_secret_basic` or `client_secret_post` |

These fields are refused, because they're secrets or short-lived: `access_token`, `expires_at`, `refresh.refresh_token` and `refresh.token_endpoint_auth.client_secret`.

### `environment_variable`

A secret, such as an API key, that the agent's commands can use. The sandbox only sees a placeholder, and the real value is substituted on requests to the hosts you allow.

```markdown path=vaults/secrets/stripe.md
---
auth:
  type: environment_variable
  secret_name: STRIPE_API_KEY
  networking:
    type: limited
    allowed_hosts:
      - api.stripe.com
  injection_location:
    header: true
    body: false
---
```

| Field | Rules |
|---|---|
| `auth.secret_name` | Required. A variable name like `STRIPE_API_KEY` |
| `auth.networking.type` | Required. `limited` or `unrestricted` |
| `auth.networking.allowed_hosts` | Required with `limited`. The hosts the secret may be sent to |
| `auth.injection_location` | Optional. Where in a request the secret can appear |

`secret_value` is refused, because that's the secret.

**`injection_location`:** with no block at all, both `header` and `body` are on. With a block, a field you leave out is off, and at least one must be on.

**`unrestricted` networking** gets a warning, because the secret is substituted on requests to any host, and a prompt-injected agent could send it anywhere.

Across files, `check` also warns when:

- Two vaults set the same variable, because the API doesn't document which wins.
- The environment is self-hosted, which doesn't support these yet.
- One of `allowed_hosts` isn't reachable under [`env.md`](env.md)'s limited networking.

## Creating a credential

`deploy` creates vaults, but it can't create a credential, because that needs its secrets. It reports each one that doesn't exist yet as `missing`. There are three commands for this:

| Command | What it does |
|---|---|
| `cred create [dir]` | Asks questions, writes the file, then gets the secrets and creates the credential, unless you choose to do that later |
| `cred deploy <file>` | Creates the credential a file describes, by signing in or pasting its secrets |
| `cred login <file>` | Signs in with the browser, creating the credential, or replacing the tokens of the existing one |

Each creates the vault first if it hasn't been deployed. The lock records the credential's ID and vault ID, and never its secrets. After creating an `mcp_oauth` credential, agentschema asks the API to try it, and warns if the API can't confirm it works.

A credential that already exists can't be created again. To replace its secrets, delete it with `cred delete`, which keeps the file, then create it again. `cred login` can also put new tokens in an existing credential.

## How signing in works

`cred login` follows the MCP authorization spec:

1. **It finds the sign-in** from the server's URL, using protected resource metadata (RFC 9728), then authorization server metadata (RFC 8414) or OpenID Connect discovery.
2. **It finds an OAuth client.** That's the file's `auth.refresh.client_id` if there is one. Otherwise, if the server allows it, agentschema registers itself as a client (RFC 7591), and writes the `refresh` block into the file. If neither works, it explains how to create your own client and what to add.
3. **It signs you in with the browser,** using the authorization code flow with PKCE (S256), and receiving the code on `http://127.0.0.1:<port>/callback`. It waits up to 5 minutes. Use `--port` if your OAuth client needs a fixed redirect URI.
4. **It sends the tokens straight to the vault,** and never writes them to disk.
5. **It lists the server's tools** in its [tool file](tools.md#listing-a-servers-tools), if that has no table yet.

If the server doesn't return a refresh token, nothing is created, because the credential would stop working when the access token expires. Google only issues one for offline access on a fresh consent, so agentschema asks for that.

## Updating a credential

`deploy` keeps a credential's settings in sync with its file, but some fields can't change on an existing credential. Changing one stops the deploy with an error, before any vault or credential change is sent. Delete the credential and create it again.

| Type | Can't change |
|---|---|
| `mcp_oauth` | `type`, `mcp_server_url`, `refresh` being there or not, `refresh.token_endpoint`, `refresh.client_id`, `refresh.resource`, `refresh.token_endpoint_auth.type` |
| `environment_variable` | `type`, `secret_name` |

What can change is the name, metadata, `refresh.scope`, `networking` and `injection_location`. Secrets stay as they are in the vault.

## In a session

A session gets every deployed vault in `vaults/`, in name order. When two hold a credential for the same server, the first one wins. `run` warns about vaults that haven't been deployed, and credentials that haven't been created.

Vaults belong to a workspace, so a new API key from another workspace means creating credentials and signing in again.
