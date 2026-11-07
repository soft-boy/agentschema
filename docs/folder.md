# Files and folders

## What's part of an agent

`agent.md` and `env.md` are required, and everything else is optional. When agentschema reads a folder, it only takes these, and ignores everything else there, such as a README:

| Path | Read as |
|---|---|
| `agent.md` | [The agent](agent.md) |
| `env.md` | [Its environment](env.md) |
| `tools/`, at any depth | [Tool files](tools.md). Only `.md` files are tools, so helper code can sit beside them |
| `skills/<name>/`, at any depth | [Skills](skills.md). Every file in the folder is uploaded |
| `vaults/<vault>/` | [A vault and its credentials](vaults.md) |
| `channels/` | [Channels](channels.md), directly inside the folder |
| `scheduled/` | [Scheduled tasks](scheduled.md), directly inside the folder |

Two more files can sit in the folder, and neither is part of the agent's definition:

- **`claude-lock.json`** is written by `deploy`. It holds IDs and hashes, not secrets, and is meant to be committed. See [Deploying and the lock](deploy.md).
- **`.env`** holds settings for your custom tools, and is only read by `run`. It holds secrets, so don't commit it. See [Sessions](sessions.md#env).

## What's left out

- **Hidden files and `node_modules`** are never part of an agent, at any depth.
- **Empty folders** aren't, because an agent is only a map of file paths.
- **Symbolic links** are followed to files in `tools/`, `vaults/`, `channels/` and `scheduled/`. They aren't followed in `skills/`, because everything there gets uploaded, and a link could point outside the agent.

## Names

Names are exact, so that an agent behaves the same on a case-sensitive file system:

- `agent.md` and `env.md` must be lowercase. `AGENT.md` is an error that says what it found.
- `SKILL.md` must be uppercase.
- `vault.md` means a vault's own settings, so it can't be a credential.

Many things take their name from their file or folder, and if a file also states its name, the two must match:

| Thing | Name comes from | Must also match |
|---|---|---|
| Custom tool | File name | Frontmatter `name` |
| MCP toolset | File name | `mcp_server_name`, and a server in `agent.md` |
| Agentbook toolset | File name | `toolset` |
| Skill | Folder name | Frontmatter `name` |
| Vault | Folder name | Nothing; `display_name` is refused |
| Credential | File name | Nothing; `display_name` is refused |
| Channel | File name | Nothing |
| Scheduled task | File name | Nothing; it's also the deployment's name |

Renaming a file or folder that the lock tracks makes a new resource, because the lock is keyed by path. See [Deploying and the lock](deploy.md#renaming-and-removing).

## Markdown rules

Every `.md` file agentschema parses, other than a skill's supporting files, has the same shape:

```
---
key: value
---

The body.
```

- The file must start with a `---` line, and the frontmatter must be closed with another. Spaces or tabs after the closing `---` are fine.
- The frontmatter must be a YAML mapping. It can be empty.
- A byte order mark at the start is dropped, and Windows line endings are treated as `\n`.
- The body is everything after the closing line, with whitespace trimmed from both ends.
- Errors name the file, and the line for invalid YAML: `agent.md:3: invalid YAML: …`.

### YAML that surprises people

YAML reads some values as something other than text, so quote them:

- **Phone numbers:** `+14155550123` is read as a number, losing the `+`.
- **Long IDs and versions:** `version: 1.10` is read as a number, and so is `client_id: 12345`.
- **Metadata values:** these must be strings, so write `priority: "1"`.
- **A lone `*`:** in `allow: *`, an unquoted `*` is YAML syntax. Write `allow: "*"`.

When agentschema expects text and finds a number, the error usually says to add quotes.

## Secrets

Files never hold secrets. `check` scans the raw text of every file, including every skill file, and refuses anything that looks like:

- An Anthropic API key (`sk-ant-…`)
- A GitHub token (`ghp_…`, `github_pat_…`)
- A Slack token (`xoxb-…` and similar)
- An AWS access key (`AKIA…`)
- A Telegram bot token
- A SendGrid API key (`SG.…`)
- A Twilio account or API key SID (`AC…`, `SK…`)
- A Discord bot token

It also refuses the fields that would hold a secret, such as a credential's `auth.access_token` or a channel's `bot_token`. These checks catch mistakes, and a secret in another format won't be noticed, so stay careful.

## File maps

Internally, an agent is a file map: an object from paths to contents.

```js
const files = {
  "agent.md": "---\nname: Support\nmodel: claude-opus-5-5\n---\n\nHelp people.\n",
  "env.md": "---\nname: support\n---\n",
  "tools/linear.md": "…",
};
```

Paths are relative and use forward slashes. Contents are a string, or bytes (a `Uint8Array`) for files that may not be text. A folder on disk, a browser editor and a database row all have this in common, so nothing in agentschema's core needs to know where the files came from. See [Library](library.md).

A path like `tools` with contents, rather than a folder, is an error: `tools: not a directory`. The same goes for `skills`, `vaults`, `channels` and `scheduled`.
