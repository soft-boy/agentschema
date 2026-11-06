# Command line

```sh
npm install -g @soft-boy/agentschema
```

This installs `agentschema`, and `ags` as a short name for it. `dir` defaults to the current directory. Use `-h` for help on any command group, and `-v` for the version.

## Signing in

Every command but `init`, `check` and `tools create` calls the API. They use `ANTHROPIC_API_KEY` if it's exported, or otherwise your `ant auth login` profile, and everything is created in that key's workspace. `deploy --dry-run` works without either. `.env` files aren't used for this.

## Commands

### `init <name>`

Scaffolds a new agent folder, and refuses a folder that already has something in it. It asks for a name, model, system prompt, whether to give it the pre-built tools and with what permission, an environment name, and its networking.

| Option | What it does |
|---|---|
| `-y`, `--yes` | Skips the questions. The defaults are `claude-opus-5-5`, all eight pre-built tools on `auto`, and limited networking with package managers allowed |

### `check [dir]`

Validates the folder without calling the API. It prints warnings and errors, and exits with status 1 on any error. See [Checking](check.md).

### `deploy [dir]`

Creates or updates the skills, environment, agent and vaults, and writes `claude-lock.json`. See [Deploying and the lock](deploy.md).

| Option | What it does |
|---|---|
| `--dry-run` | Shows what would change, and changes nothing |
| `--force` | Updates the agent even if it was changed outside this folder |

### `run [dir]`

Chats with the deployed agent in a new session, in the terminal, loading `dir/.env` for your custom tools. See [Sessions](sessions.md).

| Option | What it does |
|---|---|
| `--resume <id>` | Continues a session instead of starting one |

### `list`

Lists the agents in your workspace, with their IDs, versions, models and when they last changed.

### `delete <agent_id>`

Archives an agent. Agents can't be deleted outright, an archived agent drops out of `list`, and it can't be undone.

| Option | What it does |
|---|---|
| `-y`, `--yes` | Doesn't ask for confirmation. Without a terminal, this is required |

### `tools create [dir]`

Adds a tool, asking which kind:

- **Pre-built tools:** writes `tools/agent_toolset_20260401.md`, asking which to turn on and with what permission. It refuses if the agent already has that file.
- **A custom tool:** asks for its name, description and inputs, and writes a file with code to fill in.
- **An MCP server:** asks for its URL, name and permission, adds it to `mcp_servers` in `agent.md` if needed, asks the server for its tools, and writes the file.

### `sessions list`

Lists the sessions in your workspace, newest first.

### `sessions delete <id>`

Deletes a session and its history, which can't be undone. It refuses a session that's running.

| Option | What it does |
|---|---|
| `-y`, `--yes` | Doesn't ask for confirmation |

### `cred create [dir]`

Adds a credential, asking which vault it goes in, and whether it's for an MCP server or an environment variable. It writes the file, then signs you in or asks for the secrets, and creates it in Anthropic. You can choose to only write the file. See [`vaults/`](vaults.md).

### `cred deploy <file>`

Creates the credential a file describes, by signing in or pasting its secrets. Secrets you paste aren't shown, and aren't saved.

### `cred login <file>`

Signs in to the credential's MCP server in the browser, then creates the credential, or replaces the tokens of the existing one. See [How signing in works](vaults.md#how-signing-in-works).

`cred create`, `cred deploy` and `cred login` take:

| Option | What it does |
|---|---|
| `--port <port>` | The port for the sign-in redirect. The default is any free port |

### `cred delete <file>`

Deletes the credential a file describes from Anthropic, and from the lock. The file stays, so it can be created again.

| Option | What it does |
|---|---|
| `-y`, `--yes` | Doesn't ask for confirmation |

## Exit status

Commands exit with 0 on success and 1 on failure. Errors are printed as `error: …`, and warnings as `warning: …`.

## Getting started

```sh
agentschema init my-agent --yes
agentschema deploy my-agent
agentschema run my-agent
```
