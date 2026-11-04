# agentschema

Define an AI-Agent as a folder of Markdown files.

```
my-agent/
├── agent.md                      # the agent
├── env.md                        # the environment it runs in
├── tools/                        # tool files, in any folders you like
│   ├── agent_toolset_20260401.md # the pre-built tools to enable
│   └── get_weather.md
├── skills/                       # instructions the agent loads when a task needs them
│   └── code-review/
│       └── SKILL.md
└── vaults/                       # credentials for MCP servers and API keys
    └── Ops/                      # a vault, named after its folder
        └── Slack.md              # a credential, without its secrets
```

**Status:** v0.2.1 draft. v0.2 breaks from the Claude Managed Agents schema: tools move out of `agent.md` and into `tools/`.

## Philosophy

1. **One folder, one agent.** A folder defines one agent, the one environment it runs in, and the shared vaults its runs use. Sessions, each user's own credentials, mounted files and repositories, and schedules are supplied by whatever runs the agent.
2. **Everything is a Markdown file.** An agent is plain files you can read, diff, review and version like any other code. Structured settings go in YAML frontmatter, and prose the model reads goes in the Markdown body.
3. **Inspired by Claude Managed Agents, not tied to it.** `agent.md` and `env.md` use the Claude Managed Agents fields because they're a well-documented vocabulary for agents. Tools are the exception: they're split into their own files, and agentschema compiles them into the API's format. The format itself assumes no particular infrastructure, so any runtime that can read the files can run the agent.

## Install

```sh
npm install -g @soft-boy/agentschema
```

This installs the `agentschema` command, and `ags` as a short name for it.

## Specification

### Files

An instance is a folder of Markdown files. `agent.md` and `env.md` are required.

```
my-agent/
├── agent.md                      # the agent
├── env.md                        # the environment (computer)
├── tools/                        # tool files, nested however you like
│   ├── agent_toolset_20260401.md # the pre-built tools to enable
│   └── get_weather.md
├── skills/                       # optional: one folder per skill
│   └── code-review/
│       ├── SKILL.md
│       └── checklist.md          # any other files the skill needs
└── vaults/                       # optional: one folder per vault
    └── Ops/
        ├── vault.md              # optional: the vault's metadata
        └── Slack.md              # one file per credential
```

### `agent.md`
Field reference: [Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).

- **Frontmatter** uses the fields of a Claude Managed Agents agent (the `POST /v1/agents` request body), written as YAML. `name` and `model` are required. Every other field (`description`, `mcp_servers`, `skills`, `multiagent`, `metadata`, …) is optional and uses the same names and shapes.
- **Body** is the agent's system prompt, sent as `system` exactly as written (leading and trailing whitespace trimmed). An empty body means no system prompt.
- Setting `system` in the frontmatter is an error, because the body is the system prompt. So is `tools`, because tools live in `tools/`.

### `env.md`
Field reference: [Environments](https://platform.claude.com/docs/en/managed-agents/environments).

- **Frontmatter** uses the fields of a Claude Managed Agents environment (the `POST /v1/environments` request body), written as YAML: `name`, `config`, and any other field the schema defines. 
- **Body** is a note for people reading the folder. It is not sent anywhere.

### `tools/`

Each `.md` file in `tools/` is the pre-built toolset, one MCP server, or one custom tool. `agentschema tools create` writes any of them for you.

Subfolders are only for organizing. Every `.md` file under `tools/`, at any depth, is read, and its folder is ignored when compiling: moving a file between folders changes nothing that's deployed. Because the folders are dropped, two custom tools, or two MCP toolsets, can't share a name even in different folders. Folders and files whose names start with `.` are skipped.

**Pre-built tools** are the tools Claude Managed Agents runs in the container: `bash`, `edit`, `glob`, `grep`, `read`, `web_fetch`, `web_search` and `write`. One file lists the ones the agent gets. By convention it's `tools/agent_toolset_20260401.md`, but the file name isn't used:

```markdown
---
type: agent_toolset_20260401
---

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `bash` | `true` | `always_ask` |
| `read` | `true` | |
| `web_search` | `false` | |
```

- **Frontmatter** is only `type: agent_toolset_20260401`.
- **`## Tools`** has a row for each tool you configure. **Enabled** is `true` or `false`. A tool without a row keeps the API's default, which is enabled. With no file at all, the agent gets no pre-built tools.
- **Permission** is `always_allow`, `always_ask` or `auto`. Leave the cell blank for the API's default (`always_allow`), or leave out the column entirely.
- There can be only one such file. Other sections are notes for people.

**MCP toolsets** give the agent the tools a remote MCP server offers. Declare the server in `agent.md`, with the API's fields:

```yaml
mcp_servers:
  - type: url
    name: calendar
    url: https://calendarmcp.googleapis.com/mcp/v1
```

Then give it one file in `tools/`, named after the server:

```markdown
---
type: mcp_toolset
mcp_server_name: calendar
default_config:
  enabled: false
---

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `list_events` | `true` | `always_allow` |
| `create_event` | `true` | |
```

- **`mcp_server_name`** is required, and must match both the file name and a server in `agent.md`. A server with no toolset file is an error too, because the API rejects it.
- **`default_config`** is optional, and applies to every tool without a row: `enabled` and `permission_policy`, as in the API. Without it, all the server's tools are on, and they ask for approval before each call (`always_ask`). `enabled: false`, as above, turns on only the tools you list.
- **`## Tools`** is optional, and configures tools by the names the server reports. The server defines its own tools, so `check` can't verify these names.
- **Sign-in:** a server that needs it gets its credentials from `vaults/`, matched by URL. `agentschema cred create` offers the servers in `agent.md`.
- **Networking:** with `limited` networking in `env.md`, set `allow_mcp_servers: true` or add the server's host to `allowed_hosts`, or the API won't start sessions. `check` warns about this.

An agent can have up to 20 MCP servers.

**Custom tools** run on your side: when the agent calls one, `agentschema run` runs its code on your machine and sends back the result.

````markdown
---
type: custom
name: get_weather
description: Get the current weather for a city.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `city` | `string` | City name | `true` |

## Code

```javascript
module.exports = ({ city }) =>
  fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`).then((r) => r.text());
```
````

- **Frontmatter:** `type: custom`, a `name` that matches the file name, and a `description` the model reads to decide when to call the tool. The name can't reuse a pre-built tool's name (so `read_file` works, but not `read`), because the API rejects that.
- **`## Input Schema`** is a table with the columns Name, Type, Description and Required. Type is `string`, `number`, `integer`, `boolean`, `object` or `array`, or one of those followed by `[]` for a list. Leave the section out for a tool that takes no input.
- **`## Code`** is required, and must be one JavaScript code block. It's a CommonJS module, and `module.exports` is the function. It's called with the call's input as an object. A string it returns (or resolves to) is sent as the result; anything else is sent as JSON. If it throws, the error message is sent as an error result. `require()` resolves from the tool's file, so packages installed in the agent folder work.
- Other sections are notes for people.

**Compiling.** `deploy` turns `tools/` into the agent's `tools` list, sorted by tool name: one `agent_toolset_20260401` entry with a config for each row of the `## Tools` table (its `enabled`, and its `permission_policy` if it has one), then an `mcp_toolset` entry for each MCP toolset file, then the custom tools. A custom tool sends only its name, description and input schema; the code never leaves your machine.

### `skills/`
Field reference: [Skills](https://platform.claude.com/docs/en/managed-agents/skills).

Skills are instructions, and optionally scripts or reference files, that the agent loads only when a task calls for them. Each folder in `skills/` is one skill, following the standard layout: a `SKILL.md`, plus any other files it needs, at any depth.

```markdown
---
name: code-review
description: Review code for bugs, security problems and missing tests. Use when asked to review a change.
---

Read `checklist.md`, then go through the change one file at a time.
```

- **`name`** is required, and must match the folder's name. It may use lowercase letters, digits and hyphens, up to 64 characters, and can't contain `anthropic` or `claude`.
- **`description`** is required, up to 1,024 characters, with no XML tags. The agent reads it to decide when to load the skill. Other frontmatter fields are left as written.
- **Files:** hidden files and `node_modules` aren't uploaded. A skill's files can add up to 30 MB.
- **Everything in the folder is uploaded to Anthropic,** so keep secrets out. `check` scans these files too.

Every skill in the folder is attached to the agent. To use Anthropic's pre-built skills, or a skill that already exists in your workspace, list it under `skills` in `agent.md`'s frontmatter, as in the API; `deploy` adds the folder's skills to that list.

### `vaults/`
Field reference: [Vaults](https://platform.claude.com/docs/en/managed-agents/vaults).

Vaults hold the credentials the agent's MCP servers and API calls need. Each folder in `vaults/` is one vault, and the folder name is the vault's name. `run` attaches every vault to its session, in folder name order: when two vaults have a credential for the same server, the first one wins.

- **`vault.md`** is optional. Its frontmatter takes the vault's `metadata`; the body is a note for people.
- **Every other `.md` file is a credential**, and the file name is the credential's name. It's either `mcp_oauth`, for an MCP server's sign-in, or `environment_variable`, for an API key. A vault holds at most 20, one per MCP server or variable.

A credential file holds its settings, using the fields of the API's `auth` object, but never its secrets. This is an `mcp_oauth` credential:

```markdown
---
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
```

- **No secrets.** `access_token`, `expires_at`, `refresh.refresh_token` and `token_endpoint_auth.client_secret` are errors in a file. The `cred` commands get them by signing you in, or ask you to paste them; either way they go straight to the vault, so they're never on disk and everything in `vaults/` can be committed. The vault is their source of truth from then on: Anthropic refreshes the access token, and many providers replace the refresh token each time.
- **`refresh`** is optional, but without it the credential stops working when the access token expires.
- **Some fields can't change** once the credential exists: `type`, `mcp_server_url`, whether there's a `refresh` block, and its `token_endpoint`, `client_id`, `resource` and `token_endpoint_auth.type`, or an environment variable's `secret_name`. Changing one is an error at `deploy`; delete the credential with `cred delete` and create it again. Other settings, the metadata and the note can change.

An `environment_variable` credential gives code in the agent's container an API key it never sees. The sandbox holds a placeholder, and Anthropic swaps in the real value as a request leaves:

```markdown
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

- **`networking`** is required, and says which hosts get the real value. It doesn't open the network: with `limited` networking in `env.md`, those hosts must be allowed there too, and `check` warns if they aren't. `unrestricted` substitutes the value on a request to any host, so a prompt-injected agent could send it anywhere; `check` warns about that as well.
- **`injection_location`** is optional, and says where in a request the value may appear. Without it, both are on; with it, a field you leave out is off.
- **It holds one fixed value,** so it suits long-lived keys, not tokens that expire. It only reaches code in the container, so custom tools can't use it, because they run on your side. It isn't supported on self-hosted environments yet.
- **Two vaults setting the same variable:** the docs don't say which wins, so `check` warns.

## Usage

```sh
agentschema init <name>               # scaffold a new agent folder
agentschema check [dir]               # validate the folder, no network
agentschema deploy [dir]              # create or update the skills, agent, environment and vaults
agentschema run [dir]                 # chat with the deployed agent in the terminal
agentschema list                      # list the agents in your workspace
agentschema delete <agent_id>         # archive an agent
agentschema tools create [dir]        # add pre-built tools, a custom tool or an MCP server
agentschema sessions list             # list the sessions in your workspace
agentschema sessions delete <id>      # delete a session
agentschema cred create [dir]         # add a credential to a vault, asking a few questions
agentschema cred deploy <file>        # create a credential file's credential in Anthropic
agentschema cred login <file>         # sign in to a credential's server in the browser
agentschema cred delete <file>        # delete a credential
```

`dir` defaults to the current directory. `ags` is a short name for `agentschema`. `agentschema -h` lists the commands; `tools`, `sessions` and `cred` have their own help, such as `agentschema cred -h`.

**`init`** creates the folder `<name>` with an `agent.md` and an `env.md` that pass `check`. It asks for:
- the agent's name and model
- its system prompt
- whether it gets the pre-built tools; if so, `init` writes `tools/agent_toolset_20260401.md` listing all eight
- the environment's name and networking

Press Enter to keep the default shown, or pass `--yes` to skip the questions. `init` won't write into a folder that already has files in it.

**`check`** reads every file and reports every problem it finds:
- a missing file, or a name that isn't lowercase
- frontmatter that is missing, unclosed, or invalid YAML
- a missing `name` or `model`, or a `system` or `tools` key in `agent.md`'s frontmatter
- a pre-built tools table that names an unknown tool or permission, an MCP server without both its entry in `agent.md` and its toolset file, or a custom tool with a missing description, a malformed input table, or code that isn't JavaScript or doesn't parse
- a skill with no `SKILL.md`, or a `name` or `description` the API would reject
- a credential file with a secret in it, a missing field, or two credentials for the same server
- values over the API's limits
- anything that looks like an API key or token

Unknown fields are only warnings, because they're sent to the API as written. `check` exits with status 1 when there are errors.

**`deploy`** runs `check` first, then creates or updates the skills, the environment, the agent and the vaults, and records their IDs in `claude-lock.json` in the folder. Commit that file.
- **Later runs update the same resources.** A file that hasn't changed since the last deploy is skipped. Each change to `agent.md` or `tools/` adds a new version of the agent, and sessions already running keep the version they started on.
- **The files are the source of truth.** A field you delete from a file is cleared on the next deploy, rather than left at its old value.
- **Changes made elsewhere aren't overwritten silently.** If the agent was changed outside the folder since the last deploy, `deploy` stops; `--force` overwrites it.
- **A changed skill gets a new version.** Any change to a skill's files uploads the whole folder as a new version. The agent is pinned to skill versions, so that also adds a new version of the agent, and sessions already running keep what they started on. Deleting a skill's folder detaches it from the agent, but the skill stays in your workspace until you delete it in the Console. Renaming the folder creates a new skill.
- **Credentials are updated, not created.** Creating a credential needs its secrets, which aren't in the files, so `deploy` lists each credential file that has no credential yet, with the `cred deploy` command to run. It updates the settings of credentials that exist.

`claude-lock.json` uses the same layout as `ant apply`'s, so `deploy` updates resources that `ant apply` created. The two tools hash files differently, though, so the first `deploy` after an `ant apply` updates both resources even if nothing changed.

**`run`** starts a session on the agent and environment in `claude-lock.json`, then opens a chat in the terminal. Deploy first; if you've edited the files since, `run` warns you and still uses the deployed version.
- **Messages:** type a message and press Enter. The agent's replies stream in, with a one-line summary of each tool call.
- **Approvals:** when a tool call needs approval (`always_ask`, or `auto` when the server can't decide), `run` asks you. Answer `y` to allow it, or type a reason to deny it; the agent sees the reason.
- **Custom tools:** `run` runs the tool's code from `tools/` and sends back the result. The code runs on your machine with your permissions, like any script in the folder. Settings the code needs can go in a `.env` file in the agent folder, as `KEY=VALUE` lines, which `run` loads before it starts. Keep `.env` out of git. A variable already set in your shell wins, and `.env` doesn't change which Anthropic credentials `run` uses. If the folder doesn't pass `check`, or the tool isn't in it (for example, when you resume a session from somewhere else), `run` shows the call's input and asks you to type the result.
- **Interrupting:** Ctrl+C interrupts the agent mid-turn, and a second Ctrl+C quits. Ctrl+D quits at the prompt.
- **Vaults:** the session gets every vault in `vaults/` that's been deployed, in folder name order. `run` warns about vaults that haven't been deployed and credentials that haven't been created.
- **Resuming:** quitting leaves the session in place, and `run` prints a command to resume it: `agentschema run --resume sesn_…`.

```sh
agentschema run --resume sesn_…   # resume an existing session
```

To run the agent from your own code, create a session with the agent and environment IDs from the lock file.

**`list`** prints every agent in your workspace, with its ID, latest version, model and when it was last updated. It includes agents that weren't deployed with agentschema, and leaves out archived ones.

**`tools create`** adds a tool, asking a few questions like `init`. It only writes files; `deploy` sends them to the API.
- **Pre-built tools:** turn on all eight, or pick them one by one. It writes `tools/agent_toolset_20260401.md`, and stops if the agent already has that file.
- **Custom tool:** its name, what it does, and each input's name, type, description and whether it's required. It writes `tools/<name>.md` with a code block to fill in, which throws "isn't implemented yet" until you do.
- **MCP server:** its URL, its name and the permission for its tools. It asks the server for its tools, adds the server to `mcp_servers` in `agent.md`, keeping the rest of that file as written, and writes `tools/<name>.md` with a `## Tools` table listing them all as enabled, with that permission; edit the table to turn tools off. If `agent.md` already declares that server, it only writes the file. A server that won't list its tools without signing in gets no table, so every tool is on with that permission. A tool the server adds later isn't in the table, so it gets the API's defaults.

**`sessions list`** prints every session in your workspace, newest first, with its status, the agent and version it runs, and its title. Pass an ID to `run --resume` to pick a session back up.

**`delete`** archives an agent. The API can't delete agents outright, so this is as close as it gets. An archived agent drops out of `list`, and the API has no way to unarchive it. If the agent is in a folder's `claude-lock.json`, remove its entry so the next `deploy` creates a new one.

**`sessions delete`** permanently deletes a session and its event history. A running session can't be deleted; wait for it to go idle, or interrupt it, first.

Both ask for confirmation first, showing the agent's name or the session's title. Pass `--yes` to skip that, for example in scripts; without a terminal to ask in, they refuse unless you pass `--yes`.

**`cred create`** adds a credential, asking a few questions like `init`:
1. Which vault it goes in: one in `vaults/`, or a new one.
2. Whether it's for an MCP server's sign-in or an environment variable.
3. For an MCP server: which one (from `agent.md`'s `mcp_servers` where the vault has no credential for it yet, or any URL), its name, and how to get its tokens: sign in with the browser (when the server publishes an OAuth sign-in), paste them, or just write the file for later.
4. For an environment variable: its name, the hosts it may be sent to, where in a request it can appear, the credential's name, and whether to paste the value now or just write the file. The menu only writes `limited` networking; edit the file for `unrestricted`.

It writes `vaults/<vault>/<name>.md`, asking for the OAuth client's details when the file needs them. Then it signs you in as `cred login` does, or asks for the tokens without showing what you type: the access token, when it expires, and with a `refresh` block, the refresh token and client secret. It creates the vault first if it hasn't been deployed. If you chose to just write the file, create the credential later with `cred deploy`.

**`cred deploy`** creates the credential an existing file describes in Anthropic, such as one you wrote by hand or one `deploy` lists as missing: `agentschema cred deploy my-agent/vaults/Ops/Slack.md`. It asks whether to sign in with the browser or paste the tokens; for an environment variable, it just asks for the value. A credential that already exists is an error when pasting; to replace its tokens, run `cred login`, or delete it and deploy it again.

**`cred login`** creates a credential by signing you in to its MCP server in the browser, for example `agentschema cred login my-agent/vaults/Ops/Linear.md`. The file needs only `type` and `mcp_server_url`:
1. It finds the server's sign-in from its URL, using the OAuth metadata MCP servers publish.
2. It needs an OAuth client. With a `refresh` block in the file, it uses that block's `client_id`, and asks for the client secret unless `token_endpoint_auth.type` is `none`. Without one, it registers agentschema as a client, which servers such as Linear and Notion allow, and writes the `refresh` block into the file.
3. It opens your browser to sign in, and receives the result on `http://127.0.0.1:<port>/callback`. The port is any free one, or `--port`.
4. It creates the credential with the tokens, creating the vault first if needed. If the credential already exists, it replaces its tokens instead, so signing in again is how you renew a credential whose refresh token stopped working.

It stops without creating anything if the server doesn't return a refresh token, since the credential would stop working within the hour.

Some servers, such as Google's and Slack's, don't let apps register themselves. For those, create an OAuth client with the provider first, add its details to the file's `refresh` block (`cred login` prints what to add), and allow the redirect URI `http://127.0.0.1:<port>/callback`. A client that needs an exact redirect URI needs a fixed `--port`. For Google, `cred login` also asks for offline access, which Google requires before it issues a refresh token.

**`cred delete`** permanently deletes the credential a file describes and removes it from `claude-lock.json`. The file stays, so you can create it again. It asks for confirmation unless you pass `--yes`.

### Authentication

agentschema has no account setting of its own. Every command except `init` and `check` uses whichever Anthropic credentials are in your shell:

1. `ANTHROPIC_API_KEY`, if it's set
2. otherwise, the profile you signed in to with `ant auth login` (the active one, or the one `ANTHROPIC_PROFILE` names)

An API key belongs to one workspace, and the agent and environment are created in that workspace. Each person deploys with their own key, and to deploy somewhere else you switch the key:

```sh
ANTHROPIC_API_KEY=sk-ant-… agentschema deploy my-agent
```

`claude-lock.json` holds the IDs from one workspace. A committed lock works for everyone whose key is in that workspace, and they all update the same agent. If you deploy the folder from a key in a different workspace, `deploy` can't find those IDs and stops. In that case, deploy from a copy of the folder, or don't commit that lock file.

## Development

```sh
npm install
npm test    # unit tests; deploy runs against a fake API client
npm link    # makes `agentschema` available globally from this checkout
```
