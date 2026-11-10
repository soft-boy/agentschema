# Checking

`agentschema check [dir]` validates a folder without calling the API. It also runs before every `deploy`, and `checkFiles(files)` does the same on a [file map](folder.md#file-maps).

## Errors and warnings

- **An error** means the agent can't be deployed, or the API would reject it. `check` exits with status 1, and `deploy` stops before sending anything.
- **A warning** means it's valid, but something probably isn't what you meant. `deploy` prints it and carries on.

All of them start with the file they're about:

```
warning: agent.md: unknown field `colour` will be sent to the API as written
error: tools/get_weather.md: `description` is required
```

If `agent.md` or `env.md` can't be read, `check` still reports what it can about the other files.

## Unknown fields

Files that map to an API object are lenient, so a new API field works before agentschema knows about it. Files only agentschema reads are strict, so a typo gets caught:

| File | An unknown field is |
|---|---|
| `agent.md`, `env.md`, and inside a credential's `auth` | A warning, and it's sent as written |
| `vault.md`, and a credential's top level | A warning, and it isn't sent, although the warning currently says it is |
| Tool files, `channels/`, `scheduled/` | An error |

`SKILL.md` frontmatter beyond `name` and `description` isn't checked.

## What it compares across files

- Every MCP server in `agent.md` has a toolset file, and every toolset file has a server.
- MCP servers are reachable under `env.md`'s networking.
- Environment variable credentials are reachable under `env.md`'s networking, and supported by its type.
- Two vaults don't set the same variable, and one vault doesn't have two credentials for one server or variable.
- Tool names are unique, and custom and agentbook tools don't collide.
- `skills` in `agent.md` and `skills/` together fit the limit.
- A channel's instructions and the system prompt together fit the limit.
- Two channels don't claim the same address.
- A channel anyone can message doesn't have tools that act for you without asking.
- The system prompt, `agent.md`'s body and `system_prompt/` together, fits the limit, and every file in `system_prompt/` is text.
- A scheduled task's agent doesn't have tools that wait for an answer, since nobody's there to give one during a run. See [Scheduled tasks](scheduled.md#nobodys-there-to-answer).

## Limits

| What | Limit |
|---|---|
| System prompt, with `system_prompt/` | 100,000 characters |
| Agent `name` | 256 characters |
| Agent `description` | 2,048 characters |
| Agent `metadata` | 16 keys |
| `mcp_servers` | 20 servers |
| MCP server `name` | 255 characters |
| MCP server `url` | 2,048 characters |
| Tools | 256 |
| Custom tool `name` | 64 characters |
| Skills, in `agent.md` and `skills/` together | 500 |
| Skill `name` | 64 characters |
| Skill `description` | 1,024 characters |
| One skill's files | 30 MB |
| Vault name | 255 characters |
| Vault `metadata` | 16 keys |
| Credentials in a vault | 20 |
| Credential name | 255 characters |
| Credential `metadata` | 16 keys |
| Channel name | 64 characters |
| Channel `greeting` | 1,000 characters |
| Scheduled task name | 64 characters |
| Scheduled task `description` | 2,048 characters |

## What it can't tell you

`check` doesn't use the network, so it can't confirm that:

- A model exists, or a key works.
- An MCP server is up, or has the tools your table names.
- A credential's secrets are right.
- Something else about the API's rules hasn't changed. The API has the last word when you deploy.

Secret scanning looks for known formats, so it can miss one. See [Secrets](folder.md#secrets).

## Options for hosts

`checkFiles(files, options)` and `check(dir, options)` take:

| Option | What it does |
|---|---|
| `customTools: false` | Refuses custom tools, for a host that won't run users' code |
| `toolsets` | The catalog behind `type: agentbook` files. See [Agentbook toolsets](tools.md#agentbook-toolsets) |
