# agentschema

Define an AI-Agent as a folder of Markdown files.

```
my-agent/
├── agent.md        # the agent
├── env.md          # the environment it runs in
└── tools/          # one file per tool, in any folders you like
    ├── built-in/
    │   ├── bash.md
    │   └── read.md
    └── read_file.md
```

**Status:** v0.2 draft. v0.2 breaks from the Claude Managed Agents schema: tools move out of `agent.md` and into `tools/`.

## Philosophy

1. **One folder, one agent.** A folder defines one agent and the one environment it runs in. Sessions, credentials, mounted files and repositories, and schedules are supplied by whatever runs the agent.
2. **Everything is a Markdown file.** An agent is plain files you can read, diff, review and version like any other code. Structured settings go in YAML frontmatter, and prose the model reads goes in the Markdown body.
3. **Inspired by Claude Managed Agents, not tied to it.** `agent.md` and `env.md` use the Claude Managed Agents fields because they're a well-documented vocabulary for agents. Tools are the exception: each one is its own file, and agentschema compiles them into the API's format. The format itself assumes no particular infrastructure, so any runtime that can read the files can run the agent.

## Install

```sh
npm install -g @soft-boy/agentschema
```

## Specification

### Files

An instance is a folder of Markdown files. `agent.md` and `env.md` are required; `tools/` is optional.

```
my-agent/
├── agent.md        # the agent
├── env.md          # the environment it runs in
└── tools/          # one file per tool, in any folders you like
    ├── built-in/
    │   ├── bash.md
    │   └── read.md
    └── read_file.md
```

### `agent.md`
Field reference: [Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup).

- **Frontmatter** uses the fields of a Claude Managed Agents agent (the `POST /v1/agents` request body), written as YAML. `name` and `model` are required. Every other field (`description`, `mcp_servers`, `skills`, `multiagent`, `metadata`, …) is optional and uses the same names and shapes.
- **Body** is the agent's system prompt, sent as `system` exactly as written (leading and trailing whitespace trimmed). An empty body means no system prompt.
- Setting `system` in the frontmatter is an error, because the body is the system prompt. So is `tools`, because tools live in `tools/`.

### `env.md`
Field reference: [Environments](https://platform.claude.com/docs/en/managed-agents/environments).

- **Frontmatter** uses the fields of a Claude Managed Agents environment (the `POST /v1/environments` request body), written as YAML: `name`, `config`, and any other field the schema defines. 
- **Body** is a note for people reading the folder. It is not sent anywhere.

### `tools/`

Each `.md` file in `tools/` is one tool, and the file name is the tool's name. agentschema supports two kinds: pre-built and custom.

Subfolders are only for organizing. Every `.md` file under `tools/`, at any depth, is a tool, and its folder is ignored when compiling: moving a file between folders changes nothing that's deployed. Because the folders are dropped, two tools can't share a name even in different folders. Folders and files whose names start with `.` are skipped. By convention, the pre-built tools go in `tools/built-in/`.

**Pre-built tools** are the tools Claude Managed Agents runs in the container: `bash`, `edit`, `glob`, `grep`, `read`, `web_fetch`, `web_search` and `write`. Name the file after the tool (for example `tools/built-in/bash.md`), and give it only a `type`:

```markdown
---
type: agent_toolset_20260401
---
```

Only the pre-built tools that have a file are enabled; delete a file to disable that tool. The body is a note for people and isn't sent anywhere.

**Custom tools** run on your side: when the agent calls one, `agentschema run` runs its code on your machine and sends back the result.

````markdown
---
type: custom
name: read_file
description: Read a file and output its contents as a string.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `filePath` | `string` | The path of the file to read | `true` |

## Code

```javascript
const fs = require('fs').promises;

module.exports = async ({ filePath }) => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    return `Error reading file: ${error.message}`;
  }
};
```
````

- **Frontmatter:** `type: custom`, a `name` that matches the file name, and a `description` the model reads to decide when to call the tool. The name can't reuse a pre-built tool's name (so `read_file`, not `read`), because the API rejects that.
- **`## Input Schema`** is a table with the columns Name, Type, Description and Required. Type is `string`, `number`, `integer`, `boolean`, `object` or `array`, or one of those followed by `[]` for a list. Leave the section out for a tool that takes no input.
- **`## Code`** is required, and must be one JavaScript code block. It's a CommonJS module, and `module.exports` is the function. It's called with the call's input as an object. A string it returns (or resolves to) is sent as the result; anything else is sent as JSON. If it throws, the error message is sent as an error result. `require()` resolves from the tool's file, so packages installed in the agent folder work.
- Other sections are notes for people.

**Compiling.** `deploy` turns `tools/` into the agent's `tools` list, sorted by tool name: one `agent_toolset_20260401` entry with `default_config: { enabled: false }` and a config enabling each pre-built tool with a file, then the custom tools. A custom tool sends only its name, description and input schema; the code never leaves your machine.

## Usage

```sh
agentschema init <name>               # scaffold a new agent folder
agentschema check [dir]               # validate the folder, no network
agentschema deploy [dir]              # create or update the agent and environment
agentschema run [dir]                 # chat with the deployed agent in the terminal
agentschema list                      # list the agents in your workspace
agentschema delete <agent_id>         # archive an agent
agentschema sessions list             # list the sessions in your workspace
agentschema sessions delete <id>      # delete a session
```

`dir` defaults to the current directory.

**`init`** creates the folder `<name>` with an `agent.md` and an `env.md` that pass `check`. It asks for:
- the agent's name and model
- its system prompt
- whether it gets the pre-built tools; if so, `init` writes a file for each one in `tools/built-in/`
- the environment's name and networking

Press Enter to keep the default shown, or pass `--yes` to skip the questions. `init` won't write into a folder that already has files in it.

**`check`** reads every file and reports every problem it finds:
- a missing file, or a name that isn't lowercase
- frontmatter that is missing, unclosed, or invalid YAML
- a missing `name` or `model`, or a `system` or `tools` key in `agent.md`'s frontmatter
- a tool file that isn't a known pre-built tool, or a custom tool with a missing description, a malformed input table, or code that isn't JavaScript or doesn't parse
- values over the API's limits
- anything that looks like an API key or token

Unknown fields are only warnings, because they're sent to the API as written. `check` exits with status 1 when there are errors.

**`deploy`** runs `check` first, then creates or updates the environment and the agent, and records their IDs in `claude-lock.json` in the folder. Commit that file.
- **Later runs update the same resources.** A file that hasn't changed since the last deploy is skipped. Each change to `agent.md` or `tools/` adds a new version of the agent, and sessions already running keep the version they started on.
- **The files are the source of truth.** A field you delete from a file is cleared on the next deploy, rather than left at its old value.
- **Changes made elsewhere aren't overwritten silently.** If the agent was changed outside the folder since the last deploy, `deploy` stops; `--force` overwrites it.

`claude-lock.json` uses the same layout as `ant apply`'s, so `deploy` updates resources that `ant apply` created. The two tools hash files differently, though, so the first `deploy` after an `ant apply` updates both resources even if nothing changed.

**`run`** starts a session on the agent and environment in `claude-lock.json`, then opens a chat in the terminal. Deploy first; if you've edited the files since, `run` warns you and still uses the deployed version.
- **Messages:** type a message and press Enter. The agent's replies stream in, with a one-line summary of each tool call.
- **Approvals:** when a tool call needs approval (`always_ask`, or `auto` when the server can't decide), `run` asks you. Answer `y` to allow it, or type a reason to deny it; the agent sees the reason.
- **Custom tools:** `run` runs the tool's code from `tools/` and sends back the result. The code runs on your machine with your permissions, like any script in the folder. If the folder doesn't pass `check`, or the tool isn't in it (for example, when you resume a session from somewhere else), `run` shows the call's input and asks you to type the result.
- **Interrupting:** Ctrl+C interrupts the agent mid-turn, and a second Ctrl+C quits. Ctrl+D quits at the prompt.
- **Resuming:** quitting leaves the session in place, and `run` prints a command to resume it: `agentschema run --resume sesn_…`.

```sh
agentschema run --resume sesn_…   # resume an existing session
```

To run the agent from your own code, create a session with the agent and environment IDs from the lock file.

**`list`** prints every agent in your workspace, with its ID, latest version, model and when it was last updated. It includes agents that weren't deployed with agentschema, and leaves out archived ones.

**`sessions list`** prints every session in your workspace, newest first, with its status, the agent and version it runs, and its title. Pass an ID to `run --resume` to pick a session back up.

**`delete`** archives an agent. The API can't delete agents outright, so this is as close as it gets. An archived agent drops out of `list`, and the API has no way to unarchive it. If the agent is in a folder's `claude-lock.json`, remove its entry so the next `deploy` creates a new one.

**`sessions delete`** permanently deletes a session and its event history. A running session can't be deleted; wait for it to go idle, or interrupt it, first.

Both ask for confirmation first, showing the agent's name or the session's title. Pass `--yes` to skip that, for example in scripts; without a terminal to ask in, they refuse unless you pass `--yes`.

### Authentication

agentschema has no account setting of its own. Every command except `init` and `check` uses whichever Anthropic credentials are in your shell:

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
