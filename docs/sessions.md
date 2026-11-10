# Sessions

A session is one conversation with a deployed agent. `agentschema run [dir]` starts one and chats with it in the terminal. A folder doesn't define sessions: they come from whatever runs the agent.

## Starting one

`run` needs `claude-lock.json` to have an agent and an environment, so deploy first. It then starts a session with:

- **The agent, pinned to the locked version,** so it runs exactly what `deploy` sent, even if the files have changed since.
- **The environment** from the lock.
- **Every deployed vault** in `vaults/`, in name order.
- **A title,** like `Support (agentschema run)`.

It warns, without stopping, when:

- `agent.md`, `system_prompt/`, `tools/`, `env.md` or a skill has changed since the last deploy. The session still uses the deployed version.
- A vault hasn't been deployed, so the session doesn't have it.
- A credential hasn't been created.

`--resume <id>` continues an existing session instead. A session that has terminated can't be resumed.

Channels play no part in `run`, which connects to nothing but the API. See [Channels](channels.md).

## A turn

For each message you send:

1. **It opens the event stream first,** because events emitted before the stream opens would never arrive. It asks for live previews of the agent's text.
2. **It sends your message.**
3. **It handles events** until the agent finishes its turn.

| Event | What happens |
|---|---|
| `agent.message` | The agent's text. Previews stream in first, and the complete message is the record, so whatever they missed is written then |
| `agent.tool_use`, `agent.mcp_tool_use` | If `evaluated_permission` is `ask`, it asks you, and sends your answer |
| `agent.custom_tool_use` | It runs your tool, or asks you for the result, and sends that back |
| `session.status_idle` | The turn is over, unless the reason is `requires_action`, which means it's waiting on one of the replies above |
| `session.status_terminated` | The session is over |

Events are deduped by ID, because the event history and the live stream overlap after a reconnect. If the stream drops, it reopens it and catches up from the history, up to 3 times.

The idle reason can also be `retries_exhausted`, when the agent gave up after repeated errors, or `budget_reached`, when the session reached its budget and paused.

## Approvals

When a tool call needs approval, `run` prints `Allow <tool>?`. Answer `y` or `yes` to allow it. Anything else denies it, and text other than `n` or `no` is sent to the agent as the reason.

## Custom tools

Each [custom tool](tools.md#custom-tools) runs on your machine when it's called. A thrown error goes back to the agent as an error result, and is shown in the terminal. If the folder doesn't pass `check`, or a call names a tool it has no file for, you're asked to type the result.

## In the terminal

- **Ctrl+C** interrupts the agent while it's working, and the turn then ends normally. Pressing it again, or at the prompt, quits.
- **Ctrl+D** quits.
- When you quit, it prints the command to resume.

## `.env`

`run` loads a `.env` from the agent folder for your custom tools. It's only for code running on your side, and it's never uploaded, so don't commit it.

```sh
# A comment
WEATHER_KEY=abc123
export OTHER_KEY="a value # not a comment\nwith a newline"
PLAIN=up to a comment # this part is dropped
```

- A variable already set in your shell wins.
- A line that isn't `KEY=VALUE` is skipped with a warning that gives its line number, without showing what's on it.
- Double quotes understand `\n` and `\"`. Single quotes are literal.
- The API client is made before this file loads, so it can't change which Anthropic account is used.

For secrets the agent's own commands need, use an [environment variable credential](vaults.md#environment_variable) instead.

## For hosts

`startSession` and `Conversation` do all this without a terminal. A host can pin a specific agent version, set a budget, and answer approvals its own way. See [Library](library.md).

A session can override `system` for itself, without changing the agent or making a new version of it: pass `system` to `startSession`. Channels use this for their instructions. The API can override `model`, `tools`, `mcp_servers` and `skills` the same way, by passing `{type: "agent_with_overrides", id, version, …}` as the agent, but `startSession` only does `system`.
