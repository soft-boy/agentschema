# `computer.md`

Defines the computer the agent's tools run on: its container, and what that can reach on the network. The frontmatter uses the fields of a [Managed Agents environment](https://platform.claude.com/docs/en/managed-agents/environments). The body is a note for people, and isn't sent anywhere.

```markdown path=computer.md
---
name: front-desk
description: Where the front desk agent runs.
config:
  type: cloud
  networking:
    type: limited
    allow_package_managers: true
    allow_mcp_servers: true
    allowed_hosts:
      - api.example.com
---

Cloud container with limited networking and package manager access.
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `name` | Yes | Text |
| `config` | No | A mapping. See below |
| `description` | No | Text |
| `metadata` | No | A mapping of text values |
| `scope` | No | Passed to the API as written |

Any other field is a warning, and it's sent to the API as written.

## `config`

| Field | Rules |
|---|---|
| `type` | `cloud` or `self_hosted` |
| `networking.type` | `limited` or `unrestricted` |

agentschema only checks those two. The rest of `config`, such as `allow_package_managers`, `allow_mcp_servers` and `allowed_hosts` under `networking`, goes to the API as written, and the API decides whether it's valid.

## What depends on this file

`check` compares other files with the environment's networking, and warns when they won't work together:

- **MCP servers:** with limited networking, a server's host must be in `allowed_hosts`, or `allow_mcp_servers` must be `true`. Otherwise the API refuses to start sessions.
- **Environment variable credentials:** a credential's `allowed_hosts` only decide where its secret is substituted. The environment decides what's reachable, so each of those hosts must also be allowed here.
- **Self-hosted environments:** environment variable credentials aren't supported on them yet.

## What `init` writes

With the defaults, `init` writes a cloud environment named after the folder, with limited networking and package managers allowed.

## Updates

Removing `description` or a `metadata` key from the file removes it from the environment when you deploy. See [Deploying and the lock](deploy.md#how-updates-work).

## Renamed from `env.md`

This file used to be called `env.md`:

- A folder that still has `env.md` works the same, and `check` warns to rename it. Having both `env.md` and `computer.md` is an error.
- A lock written before the rename keeps the environment under `./env.md`. The next deploy moves it to `./computer.md`, and updates that same environment rather than making another, so sessions and scheduled tasks keep using it.
