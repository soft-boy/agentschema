# The agentschema specification

agentschema defines an AI agent as a folder of Markdown files. You can read, diff, review and version it like any other text, and a tool can deploy it to a runtime and run it. This folder is the full specification. The [project README](../README.md) is the short introduction.

**Status:** a draft that's still changing. Today's only runtime is [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), though the format isn't meant to be tied to it.

## The smallest agent

Two files make a valid agent. The frontmatter holds settings, and the body holds prose:

```markdown path=agent.md
---
name: Support
model: claude-opus-5-5
---

You answer questions about our product, and say so when you aren't sure.
```

```markdown path=env.md
---
name: support
config:
  type: cloud
  networking:
    type: limited
---

A note for people. This isn't sent anywhere.
```

## The whole folder

```
my-agent/
├── agent.md                          # the agent, required
├── env.md                            # the environment it runs in, required
├── tools/                            # what it can do
│   ├── agent_toolset_20260401.md     # the pre-built tools to enable
│   ├── linear.md                     # an MCP server's tools
│   └── get_weather.md                # a custom tool
├── skills/                           # instructions it loads when needed
│   └── code-review/
│       └── SKILL.md
├── vaults/                           # credentials, without their secrets
│   └── secrets/
│       └── linear.md
├── channels/                         # places people can talk to it
│   └── telegram.md
├── scheduled/                        # tasks it runs on a timetable
│   └── good-morning.md
├── claude-lock.json                  # the IDs from the last deploy, written for you
└── .env                              # settings for your custom tools, never committed
```

## Principles

1. **One folder, one agent.** A folder defines one agent, its environment, and what it needs to run. Sessions and each user's own credentials come from whatever runs the agent.
2. **Everything is a Markdown file.** Settings go in YAML frontmatter, and prose goes in the body.
3. **Files never hold secrets, so they're safe to commit.** Secrets go straight to where they're used, and `check` refuses files that look like they contain one.
4. **Inspired by Claude Managed Agents, not tied to it.** The files use its field names, and tools are compiled into its format, but any runtime that can read the files can run the agent.
5. **The folder is the source of truth.** Deploying makes the runtime match the files, and if someone changed the agent elsewhere, `deploy` says so rather than silently overwriting it.

## How the files map to the runtime

| Files | Becomes | Sent by |
|---|---|---|
| `agent.md` body and frontmatter, plus `tools/` | An agent | `deploy` |
| `env.md` frontmatter | An environment | `deploy` |
| `skills/<name>/` | A skill, with a new version on each change | `deploy` |
| `vaults/<name>/` | A vault | `deploy` |
| `vaults/<name>/<credential>.md` | A credential | `cred deploy`, `cred login` or `cred create` |
| `channels/<name>.md` | Nothing: a host reads these and connects them | Not sent |
| `scheduled/<name>.md` | A deployment, which starts a session on its schedule | `deploy` |

## Words used in these docs

- **Agent folder:** a folder holding `agent.md` and `env.md`.
- **File map:** an agent as `{ path: contents }`, however it's stored. See [Files and folders](folder.md).
- **Instance:** the parsed files that `check` returns.
- **Lock:** `claude-lock.json`, which maps files to the runtime's IDs. See [Deploying and the lock](deploy.md).
- **Host:** whatever runs an agent for someone, such as this project's CLI, or a web app like Agentbook.
- **Workspace:** the part of an Anthropic account that an API key belongs to. Everything is created in the key's workspace, so a key from another workspace can't see what was deployed.

## Contents

**The format**

- [Files and folders](folder.md): layout, naming, Markdown rules and file maps
- [`agent.md`](agent.md): the agent
- [`env.md`](env.md): its environment
- [`tools/`](tools.md): pre-built tools, MCP servers, custom tools and agentbook toolsets
- [`skills/`](skills.md): instructions loaded when needed
- [`vaults/`](vaults.md): credentials
- [`channels/`](channels.md): places people can talk to the agent
- [`scheduled/`](scheduled.md): tasks it runs on a timetable

**Using it**

- [Checking](check.md): what `check` looks for, and every limit
- [Deploying and the lock](deploy.md): how files reach the runtime
- [Sessions](sessions.md): how a conversation runs
- [Command line](cli.md): every command
- [Library](library.md): running agentschema from your own code
