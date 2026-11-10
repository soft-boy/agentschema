# Deploying and the lock

`agentschema deploy [dir]` makes the runtime match the folder, and records what it created in `claude-lock.json`. Running it again with no changes makes no API calls, so it's safe to run often.

## The order

1. **Check.** Any error stops the deploy before anything is sent. A `type: agentbook` file stops it too, unless a host gives its catalog.
2. **Open the lock.** A lock written for a different API address stops the deploy, so you can't overwrite another deployment by accident.
3. **Skills,** because the agent refers to their IDs and versions.
4. **The environment.**
5. **The agent.**
6. **Vaults and credentials' settings.**
7. **Scheduled tasks,** because they refer to the agent's version, the environment and the vaults. See [Scheduled tasks](scheduled.md#deploying).

Channels aren't deployed. If a folder has any, `deploy` prints a note. See [Channels](channels.md).

Credentials are never created here, because that needs their secrets. One that doesn't exist yet shows as `missing`, with the command to create it. See [Creating a credential](vaults.md#creating-a-credential).

## What it decides for each resource

It hashes the request body it would send, and compares that with the lock:

| Action | When | Output |
|---|---|---|
| `create` | The lock has no entry | `created   agent agent_… (version 1)` |
| `update` | The hash differs | `updated   agent agent_… (version 2)` |
| `unchanged` | The hash matches | `unchanged agent agent_…` |
| `missing` | A credential that hasn't been created, or whose vault was replaced | `missing   credential …` |
| `pause`, `unpause` | A scheduled task's `enabled` changed, and nothing else did | `paused    deployment depl_…` |
| `archive` | A scheduled task's file is gone | `archived  deployment depl_… (scheduled/weekly.md is gone)` |

The hash is MD5 over the JSON with its keys sorted, so reordering YAML keys isn't a change. A skill's hash comes from each file's path and SHA-256. It isn't used for security, only to notice changes.

The agent's body includes its skill references, so a new skill version updates the agent too.

## The lock

`claude-lock.json` maps each file to what it became. It has the same layout as the one `ant apply` writes. It holds IDs and hashes, not secrets, and is meant to be committed.

```json
{
  "version": 1,
  "origin": { "base_url": "https://api.anthropic.com" },
  "resources": {
    "./skills/code-review": { "kind": "skill", "id": "skill_…", "version": "…", "hash": "…" },
    "./computer.md": { "kind": "environment", "id": "env_…", "hash": "…" },
    "./agent.md": { "kind": "agent", "id": "agent_…", "version": "3", "hash": "…" },
    "./vaults/secrets": { "kind": "vault", "id": "…", "hash": "…" },
    "./vaults/secrets/linear.md": { "kind": "credential", "id": "…", "vault_id": "…", "hash": "…" },
    "./scheduled/good-morning.md": { "kind": "deployment", "id": "depl_…", "hash": "…", "paused": false }
  }
}
```

Keys are `./` and the file's or folder's path. The environment is always under `./computer.md`, even from a folder that still uses its old name, `env.md`, and a lock that has it under `./env.md` is moved over on the next deploy. The lock is saved as soon as each resource exists, so a failure later doesn't orphan it, and the next deploy carries on from there.

An entry of the wrong `kind` for its path is an error.

## How updates work

The API's updates keep any field they aren't sent, but removing something from a file should remove it from the runtime. So `deploy` spells that out:

| Removed from the file | Sent as |
|---|---|
| The body of `agent.md` | `system: null` |
| `description`, `multiagent` in `agent.md` | `null` |
| `tools`, `mcp_servers`, `skills` | `[]` |
| `description` in `computer.md` | `null` |
| A `metadata` key, anywhere | That key as `null` |

## Changes made elsewhere

The lock records the agent's version, and an update sends it, so the API refuses if someone changed the agent since:

```
agent agent_… was changed outside this folder (claude-lock.json has version 3,
the agent is at version 5). Re-run with --force to overwrite it.
```

`--force` updates anyway. It only applies to the agent.

A resource that's gone or archived is also an error, and it says which entry to remove from the lock so that the next deploy creates a new one. A scheduled task's deployment is the exception: it's simply replaced, since it has nothing worth keeping.

## Renaming and removing

`deploy` only looks at what's in the folder. It never deletes anything from the runtime, with one exception: a scheduled task.

- **Removing** a scheduled task's file archives its deployment, because a schedule left behind would keep running, and costing money. See [Scheduled tasks](scheduled.md#deploying).
- **Removing** a skill, vault or credential file leaves the resource where it was. A session stops attaching a removed vault, but the vault still exists. Delete it in the Console. For a credential, use `cred delete` first, while the file still exists.
- **Renaming** a file or folder makes a new resource, because the lock is keyed by path. A renamed credential has to be created again.

`agentschema delete <agent_id>` archives an agent, and Anthropic archives its scheduled tasks' deployments with it. Agents can't be deleted outright, and archiving can't be undone. An archived agent's lock entry has to be removed before deploying again.

## Dry runs

`deploy --dry-run` shows what would happen and changes nothing. It makes no API calls, so it works without credentials, and it doesn't write the lock. If a skill would change, it also shows the agent as changing, even though the new version doesn't exist yet.

## Results

The library returns a plan with one entry per resource:

```js
{ file: "agent.md", kind: "agent", action: "update", id: "agent_…", version: "4" }
```

See [Library](library.md).

## Failures

An API rejection names the file:

```
agent.md: the API rejected the agent (400): …
```

An immutable field changed on a credential stops the deploy before any vault or credential change is sent. See [Updating a credential](vaults.md#updating-a-credential).
