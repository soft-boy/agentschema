# agentschema

Define a Claude Managed Agent as a folder of Markdown files.

```
my-agent/
├── agent.md   # the agent
└── env.md     # the environment it runs in
```

**Status:** v0.1 draft. The CLI is not implemented yet.

## Philosophy

1. **One folder, one agent.** A folder defines one agent and the one environment it runs in. Sessions, credentials, mounted files and repositories, and schedules are supplied by whatever runs the agent.
2. **Everything is a Markdown file.** An agent is plain files you can read, diff, review and version like any other code. Structured settings go in YAML frontmatter, and prose the model reads goes in the Markdown body.
3. **Inspired by Claude Managed Agents, not tied to it.** The fields follow the Claude Managed Agents schema because it's a well-documented vocabulary for agents. The format itself assumes no particular infrastructure, so any runtime that can read the files can run the agent.

## Install

```sh
npm install -g @soft-boy/agentschema
```

## Example

[`examples/coding-agent/agent.md`](examples/coding-agent/agent.md):

```markdown
---
name: Coding Assistant
model: claude-opus-5-5
tools:
  - type: agent_toolset_20260401
---

You are a helpful coding assistant. Write clean, well-documented code.
```

[`examples/coding-agent/env.md`](examples/coding-agent/env.md):

```markdown
---
name: quickstart
config:
  type: cloud
  networking:
    type: limited
    allow_package_managers: true
---
Cloud container with limited networking and package manager access.
```

## Specification

### Files

An instance is a folder of Markdown files.

```
my-agent/
├── agent.md   # the agent
└── env.md     # the environment it runs in
```

### `agent.md`
Field reference: [Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).

- **Frontmatter** uses the fields of a Claude Managed Agents agent (the `POST /v1/agents` request body), written as YAML. `name` and `model` are required. Every other field (`description`, `tools`, `mcp_servers`, `skills`, `multiagent`, `metadata`, …) is optional and uses the same names and shapes.
- **Body** is the agent's system prompt, sent as `system` exactly as written (leading and trailing whitespace trimmed). An empty body means no system prompt.
- Setting `system` in the frontmatter is an error, because the body is the system prompt.

### `env.md`
Field reference: [Environments](https://platform.claude.com/docs/en/managed-agents/environments).

- **Frontmatter** uses the fields of a Claude Managed Agents environment (the `POST /v1/environments` request body), written as YAML: `name`, `config`, and any other field the schema defines. 
- **Body** is a note for people reading the folder. It is not sent anywhere.

## Usage (planned)

```sh
agentschema check [dir]   # validate the folder, no network
agentschema deploy [dir]   # create or update the agent and environment
```

The first `deploy` creates both resources and writes their IDs to `claude-lock.json` in the folder; commit that file. Later runs update the same resources: each change to `agent.md` adds a new version of the agent, and sessions already running keep the version they started on.

To run the agent, create a session in your application with the agent and environment IDs from the lock file.

## Development

```sh
npm link    # makes `agentschema` available globally from this checkout
agentschema
```
