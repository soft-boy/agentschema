# agentschema

Define an AI-Agent as a folder of Markdown files.

```
my-agent/
├── agent.md   # the agent
└── env.md     # the environment it runs in
```

**Status:** v0.1 draft.

## Philosophy

1. **One folder, one agent.** A folder defines one agent and the one environment it runs in. Sessions, credentials, mounted files and repositories, and schedules are supplied by whatever runs the agent.
2. **Everything is a Markdown file.** An agent is plain files you can read, diff, review and version like any other code. Structured settings go in YAML frontmatter, and prose the model reads goes in the Markdown body.
3. **Inspired by Claude Managed Agents, not tied to it.** The fields follow the Claude Managed Agents schema because it's a well-documented vocabulary for agents. The format itself assumes no particular infrastructure, so any runtime that can read the files can run the agent.

## Install

```sh
npm install -g @soft-boy/agentschema
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

## Usage

```sh
agentschema init <name>               # scaffold a new agent folder
agentschema check [dir]               # validate the folder, no network
agentschema deploy [dir]              # create or update the agent and environment
agentschema run [dir]                 # chat with the deployed agent in the terminal
```

`dir` defaults to the current directory.

**`init`** creates the folder `<name>` with an `agent.md` and an `env.md` that pass `check`. It asks for:
- the agent's name and model
- its system prompt
- whether it gets the built-in tools, and how tool calls are approved (`auto`, `always_allow` or `always_ask`)
- the environment's name and networking

Press Enter to keep the default shown, or pass `--yes` to skip the questions. `init` won't write into a folder that already has files in it.

**`check`** reads both files and reports every problem it finds:
- a missing file, or a name that isn't lowercase
- frontmatter that is missing, unclosed, or invalid YAML
- a missing `name` or `model`, or a `system` key in `agent.md`'s frontmatter
- values over the API's limits
- anything that looks like an API key or token

Unknown fields are only warnings, because they're sent to the API as written. `check` exits with status 1 when there are errors.

**`deploy`** runs `check` first, then creates or updates the environment and the agent, and records their IDs in `claude-lock.json` in the folder. Commit that file.
- **Later runs update the same resources.** A file that hasn't changed since the last deploy is skipped. Each change to `agent.md` adds a new version of the agent, and sessions already running keep the version they started on.
- **The files are the source of truth.** A field you delete from a file is cleared on the next deploy, rather than left at its old value.
- **Changes made elsewhere aren't overwritten silently.** If the agent was changed outside the folder since the last deploy, `deploy` stops; `--force` overwrites it.

`claude-lock.json` uses the same layout as `ant apply`'s, so `deploy` updates resources that `ant apply` created. The two tools hash files differently, though, so the first `deploy` after an `ant apply` updates both resources even if nothing changed.

**`run`** starts a session on the agent and environment in `claude-lock.json`, then opens a chat in the terminal. Deploy first; if you've edited the files since, `run` warns you and still uses the deployed version.
- **Messages:** type a message and press Enter. The agent's replies stream in, with a one-line summary of each tool call.
- **Approvals:** when a tool call needs approval (`always_ask`, or `auto` when the server can't decide), `run` asks you. Answer `y` to allow it, or type a reason to deny it; the agent sees the reason.
- **Custom tools:** `run` shows the call's input and asks you to type the result.
- **Interrupting:** Ctrl+C interrupts the agent mid-turn, and a second Ctrl+C quits. Ctrl+D quits at the prompt.
- **Resuming:** quitting leaves the session in place, and `run` prints a command to resume it: `agentschema run --session sesn_…`.

```sh
agentschema run [dir] --vault vlt_…        # attach a vault for MCP or other credentials (repeatable)
agentschema run [dir] --title "Bug triage" # name the session
agentschema run --session sesn_…           # resume an existing session
```

To run the agent from your own code, create a session with the agent and environment IDs from the lock file.

### Authentication

agentschema has no account setting of its own. `deploy` and `run` use whichever Anthropic credentials are in your shell:

1. `ANTHROPIC_API_KEY`, if it's set
2. otherwise, the profile you signed in to with `ant auth login` (the active one, or the one `ANTHROPIC_PROFILE` names)

An API key belongs to one workspace, and the agent and environment are created in that workspace. Each person deploys with their own key, and to deploy somewhere else you switch the key:

```sh
ANTHROPIC_API_KEY=sk-ant-… agentschema deploy my-agent
```

`claude-lock.json` holds the IDs from one workspace. A committed lock works for everyone whose key is in that workspace, and they all update the same agent. If you deploy the folder from a key in a different workspace, `deploy` can't find those IDs and stops. In that case, deploy from a copy of the folder, or don't commit that lock file.

## Development

```sh
npm install
npm test    # unit tests; deploy runs against a fake API client
npm link    # makes `agentschema` available globally from this checkout
```
