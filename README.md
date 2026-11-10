# agentschema

[![npm](https://img.shields.io/npm/v/@soft-boy/agentschema)](https://www.npmjs.com/package/@soft-boy/agentschema)
[![downloads](https://img.shields.io/npm/dm/@soft-boy/agentschema)](https://www.npmjs.com/package/@soft-boy/agentschema)
[![node](https://img.shields.io/node/v/@soft-boy/agentschema)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@soft-boy/agentschema)](LICENSE)

Define an AI-Agent as a folder of Markdown files.

```
my-agent/
├── agent.md                          # the agent
├── env.md                            # the environment it runs in
├── system_prompt/
│   └── rules.md                      # more of the system prompt
├── tools/
│   ├── agent_toolset_20260401.md     # the pre-built tools to enable
│   └── get_weather.md                # a custom tool
├── skills/
│   └── code-review/
│       └── SKILL.md                  # instructions the agent loads when needed
├── vaults/
│   └── secrets/
│       └── creds.md                  # a credential, without its secrets
├── channels/
│   └── telegram.md                   # a place people can talk to it
└── scheduled/
    └── good-morning.md               # a task it runs on a timetable
```

**Status:** v0.2 draft. v0.2 breaks from the Claude Managed Agents schema: tools move out of `agent.md` and into `tools/`.

## Table of contents

- [Philosophy](#philosophy)
- [Install](#install)
- [Authentication](#authentication)
- [Getting started](#getting-started)
- [Specification](#specification)
  - [`agent.md`](#agentmd)
  - [`system_prompt/`](#system_prompt)
  - [`env.md`](#envmd)
  - [`tools/`](#tools)
  - [`skills/`](#skills)
  - [`vaults/`](#vaults)
  - [`channels/`](#channels)
  - [`scheduled/`](#scheduled)
- [Usage](#usage)
- [Library](#library)
- [Development](#development)
- [License](#license)

## Philosophy

1. **One folder, one agent.** A folder defines one agent, its environment, and what it needs to run. Sessions and each user's own credentials come from whatever runs the agent.
2. **Everything is a Markdown file.** Plain files you can read, diff, review and version. Settings go in YAML frontmatter, and prose goes in the body.
3. **Inspired by Claude Managed Agents, not tied to it.** The files use its field names, and tools are compiled into its format, but any runtime that can read the files can run the agent.

## Install

```sh
npm install -g @soft-boy/agentschema
```

This installs `agentschema`, and `ags` as a short name for it.

## Authentication

Commands that call the API use `ANTHROPIC_API_KEY` if it's exported, or otherwise your `ant auth login` profile. Everything is created in that key's workspace.

```sh
ANTHROPIC_API_KEY=sk-ant-…
```

## Getting started

Create an agent, deploy it, and chat with it:

```sh
agentschema init my-agent --yes
agentschema deploy my-agent
agentschema run my-agent
```

## Specification

`agent.md` and `env.md` are required; everything else is optional. `agentschema check` validates a folder without calling the API. This is the short version, and the full specification is in [docs/](docs/README.md).

### `agent.md`

The frontmatter uses the fields of a [Managed Agents agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), and `name` and `model` are required. The body is the system prompt.

### `system_prompt/`

A long system prompt can be split into files here, at any depth. They're added after `agent.md`'s body, in the order `tree` lists them, with a blank line between each one, so number them to keep them in order, like `01-role.md` and `02-rules.md`. Each file is taken as written. See [System prompt](docs/system_prompt.md).

### `env.md`

The frontmatter uses the fields of a [Managed Agents environment](https://platform.claude.com/docs/en/managed-agents/environments). The body is a note for people, and isn't sent anywhere.

### `tools/`

Every `.md` file under `tools/`, at any depth, is a tool file, and subfolders are only for organizing. `agentschema tools create` writes any of the three kinds.

**Pre-built tools** run in the agent's container. One file lists them, with a Permission of `always_allow`, `always_ask` or `auto`:

```markdown
---
type: agent_toolset_20260401
---

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `bash` | `true` | `always_ask` |
| `read` | `true` | `always_allow` |
```

**MCP toolsets** give the agent a remote server's tools. Declare the server under `mcp_servers` in `agent.md`, then add a file named after it. The `## Tools` table is optional:

```markdown
---
type: mcp_toolset
mcp_server_name: linear
---
```

**Custom tools** run on your machine when the agent calls them, and the code is never uploaded. `agentschema run` loads settings for them from a `.env` file in the folder:

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

### `skills/`

Each folder is a [skill](https://platform.claude.com/docs/en/managed-agents/skills): a `SKILL.md` plus any files it needs. `name` must match the folder. Everything in the folder is uploaded to Anthropic and attached to the agent:

```markdown
---
name: code-review
description: Review code for bugs and missing tests. Use when asked to review a change.
---

Go through the change one file at a time, and report findings by file and line.
```

### `vaults/`

Each folder is a [vault](https://platform.claude.com/docs/en/managed-agents/vaults), and each `.md` file in it is a credential, either `mcp_oauth` or `environment_variable`. Files never hold secrets, so they're safe to commit: `agentschema cred create` signs you in or asks for them, and sends them straight to the vault. For example, `vaults/secrets/creds.md`:

```markdown
---
auth:
  type: mcp_oauth
  mcp_server_url: https://mcp.linear.app/mcp
---
```

### `channels/`

Each `.md` file is a place people can talk to the agent: `telegram`, `twilio`, `sendgrid`, `email`, `slack` or `discord`. The frontmatter says who can use it and how it behaves, and the body is added to the system prompt there. `check` validates these files, but `deploy` and `run` don't connect them, because that takes a host that's always on. See [Channels](docs/channels.md):

```markdown
---
type: telegram
allow: "*"
---

You're chatting on Telegram. Keep replies short.
```

### `scheduled/`

Each `.md` file is a task the agent runs on a timetable, named after the file. The frontmatter says when, as a cron expression and a time zone, and the body is the message each run starts with. `deploy` turns each one into a Managed Agents deployment, so Anthropic starts the runs, and removing the file stops them. See [Scheduled tasks](docs/scheduled.md):

```markdown
---
schedule: "0 8 * * 1-5"
timezone: America/Los_Angeles
---

Say good morning in #gm.
```

## Usage

```sh
agentschema init <name>               # scaffold a new agent folder
agentschema check [dir]               # validate the folder, no network
agentschema deploy [dir]              # create or update the agent and everything it needs, including scheduled tasks
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

Use `agentschema --help` for more info.

## Library

agentschema can also run from your own code, on an agent held as a map of paths to file contents, wherever you store it:

```js
import { checkFiles } from "@soft-boy/agentschema"; // browser or Node
import { deployFiles } from "@soft-boy/agentschema/node"; // Node only

const { errors, warnings } = checkFiles(files);
const { plan, lock } = await deployFiles({ files, lock: savedLock, client, saveLock });
```

## Development

```sh
npm install
npm test    # unit tests; deploy runs against a fake API client
npm link    # makes `agentschema` available globally from this checkout
```

## License

[MIT](LICENSE)
