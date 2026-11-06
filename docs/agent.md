# `agent.md`

Defines the agent. The frontmatter uses the fields of a [Managed Agents agent](https://platform.claude.com/docs/en/managed-agents/agent-setup), and the body is the system prompt.

```markdown path=agent.md
---
name: Front desk
model: claude-opus-5-5
description: Answers questions and books appointments.
mcp_servers:
  - type: url
    name: linear
    url: https://mcp.linear.app/mcp
skills:
  - type: anthropic
    skill_id: pdf
metadata:
  team: support
---

You work at the front desk. Be friendly, and ask one question at a time.
```

This agent also needs a file for its MCP server:

```markdown path=tools/linear.md
---
type: mcp_toolset
mcp_server_name: linear
---
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `name` | Yes | Text, up to 256 characters |
| `model` | Yes | A model ID, or a mapping with an `id` and any other model settings, like `{id: claude-opus-5-5, effort: high}` |
| `description` | No | Text, up to 2,048 characters |
| `mcp_servers` | No | A list of up to 20 servers. See below |
| `skills` | No | A list of references to skills that aren't in this folder. See below |
| `multiagent` | No | Passed to the API as written |
| `metadata` | No | Up to 16 keys, each with a text value |
| `execution_identity` | No | Passed to the API as written |

`model` isn't limited to a known list. `init` offers `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`.

Any other field is a warning, and it's sent to the API as written, so that a new API field works before agentschema knows about it. Two fields are refused:

- **`system`:** the body is the system prompt.
- **`tools`:** each tool is a file in [`tools/`](tools.md).

## The body

The body is sent as `system`, up to the API's limit of 100,000 characters. An empty body sends no system prompt. A [channel](channels.md) can add to it for conversations on that channel.

## `mcp_servers`

Each entry is a mapping:

| Field | Rules |
|---|---|
| `type` | Must be `url` |
| `name` | 1 to 255 characters, unique in the list |
| `url` | An http(s) URL, up to 2,048 characters |

A server and its tools are declared separately, and the API rejects an agent if they don't match:

- Each server here needs a file in `tools/` with `type: mcp_toolset`, named after the server.
- Each such file needs a server here.

If `env.md` has limited networking and doesn't allow the server's host, sessions can't start, so `check` warns. To fix it, set `config.networking.allow_mcp_servers` to `true` in `env.md`, or add the host to `allowed_hosts`.

An MCP server that needs signing in also needs a [credential](vaults.md).

## `skills`

This list is for skills that live elsewhere. A skill in the folder's own `skills/` is attached automatically, and shouldn't be listed. Each entry is a mapping:

| Field | Rules |
|---|---|
| `type` | `anthropic` or `custom` |
| `skill_id` | Required. A custom skill's starts with `skill_` |
| `version` | Optional text, so quote numbers |

A plain string is an error. The list and `skills/` together can hold up to 500 skills.

## What's sent

`deploy` sends the frontmatter as written, with these added:

- `system`, from the body
- `tools`, compiled from [`tools/`](tools.md)
- `skills`, this list followed by the skills deployed from `skills/`, pinned to their versions

Removing a field from the file removes it from the agent, even though the API's updates keep anything they aren't sent. `deploy` clears it by sending `null` or an empty list. See [Deploying and the lock](deploy.md#how-updates-work).
