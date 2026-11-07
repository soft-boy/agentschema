# `tools/`

What the agent can do. Every `.md` file under `tools/`, at any depth, is a tool file. Subfolders are only for organizing, and aren't compiled into anything. Files that aren't `.md` are ignored, so helper code can sit beside the tools that use it.

A file's `type` says what it is:

| `type` | What it is | Where it runs |
|---|---|---|
| `agent_toolset_20260401` | The [pre-built tools](#pre-built-tools) | The agent's container |
| `mcp_toolset` | A [remote MCP server's tools](#mcp-toolsets) | The MCP server |
| `custom` | A [tool you write](#custom-tools) in JavaScript | The machine running `agentschema run` |
| `agentbook` | A [toolset from a host's catalog](#agentbook-toolsets) | The host |

`agentschema tools create` writes the first three for you. Each kind refuses frontmatter fields it doesn't know.

## Tables and sections

A tool file's body is split into sections at `## ` headings, ignoring case, and skipping anything inside a code block. Only the sections below mean anything, so other text is a note for people.

In a table, the first row names the columns, and the second row is the separator. Backticks around a cell are dropped, and `\|` is a literal `|`.

## Permissions

A permission says whether a tool call needs someone's approval.

| Permission | Meaning |
|---|---|
| `always_allow` | Never asks |
| `always_ask` | Asks before every call |
| `auto` | Anthropic judges each call, and asks when it can't tell |

What a blank permission means depends on the kind of tool:

| Kind | A blank permission means |
|---|---|
| Pre-built tools | The API's default, `always_allow`. `auto` is what the API recommends, and what `init` writes |
| MCP toolsets | The file's `default_config`, or else the API's default, `always_ask` |
| Agentbook toolsets | `always_ask`. They have no `auto` |

Custom tools have no permissions: when one is called, your code runs.

## Pre-built tools

The tools Claude runs in the agent's container: `bash`, `edit`, `glob`, `grep`, `read`, `web_fetch`, `web_search` and `write`. They all go in one file, by convention `tools/agent_toolset_20260401.md`. Two such files are an error.

```markdown path=tools/agent_toolset_20260401.md
---
type: agent_toolset_20260401
---

The tools Claude runs in the agent's container. Set Enabled to false to turn a tool off.

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `bash` | `true` | `always_ask` |
| `read` | `true` | `auto` |
| `write` | `false` | `auto` |
```

- The `## Tools` table is required. Its columns are `Name | Enabled`, or `Name | Enabled | Permission`.
- Each name must be a pre-built tool, listed once.
- Enabled is `true` or `false`.
- A tool the table doesn't list keeps the API's defaults, so list all eight to be sure of what's on.

It compiles to:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    { "name": "bash", "enabled": true, "permission_policy": { "type": "always_ask" } },
    { "name": "read", "enabled": true, "permission_policy": { "type": "auto" } },
    { "name": "write", "enabled": false, "permission_policy": { "type": "auto" } }
  ]
}
```

## MCP toolsets

The tools of a remote server that [`agent.md`](agent.md#mcp_servers) declares under `mcp_servers`. The file must be named after the server.

```markdown path=agent.md
---
name: Project helper
model: claude-opus-5-5
mcp_servers:
  - type: url
    name: linear
    url: https://mcp.linear.app/mcp
---

You keep our projects up to date.
```

```markdown path=tools/linear.md
---
type: mcp_toolset
mcp_server_name: linear
default_config:
  permission_policy:
    type: always_ask
---

Set Enabled to false to turn a tool off.

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `list_issues` | `true` | `always_allow` |
| `create_issue` | `true` | `always_ask` |
| `delete_issue` | `false` | `always_ask` |
```

| Field | Rules |
|---|---|
| `mcp_server_name` | Required, and must match the file name, which can be up to 255 characters |
| `default_config.enabled` | `true` or `false` |
| `default_config.permission_policy.type` | A permission |

`url` is refused, because the URL belongs in `agent.md`.

The `## Tools` table is optional, and uses the same columns as the pre-built tools. Names are whatever the server reports. Without a table, every tool the server offers gets the defaults.

A tool the server adds later isn't in the table, so it gets the defaults too: on, and asking before each call unless `default_config` says otherwise.

### Listing a server's tools

Listing tools in the file is better than leaving them implicit, because what's enabled is there to read, and can be turned off one at a time. Many servers won't say what they offer until you've signed in, so:

1. `tools create` asks the server. If it answers, the file gets a full table with the permission you chose. If it doesn't, the file keeps that permission in `default_config`, and says the tools will be listed later.
2. `cred login` asks again with the new token, and fills in the table.

Listing never overwrites a table that's already there, because it may hold choices worth keeping. A host can do the same with `listMcpTools` and `listedMcpToolset`. See [Library](library.md).

## Custom tools

A tool you write. The code runs on your machine when the agent calls it, and is never uploaded. Only the name, description and input schema reach the API.

````markdown path=tools/get_weather.md
---
type: custom
name: get_weather
description: Get the current weather for a city.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `city` | `string` | City name | `true` |
| `days` | `integer` | How many days ahead | `false` |
| `tags` | `string[]` | Labels to include | `false` |

## Code

```javascript
module.exports = async ({ city }) => {
  const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
  return response.text();
};
```
````

**`name`** must match the file name, and may use letters, digits, `_` and `-`, up to 64 characters. It can't be a pre-built tool's name, or start with `mcp__` or `ant__`, because the API rejects those. It must be unique across all of `tools/`, since folders are dropped.

**`description`** is required. Claude reads it to decide when to call the tool, so it's worth writing well.

**`## Input Schema`** is optional, for a tool with no inputs. Its columns must be `Name | Type | Description | Required`:

- Type is `string`, `number`, `integer`, `boolean`, `object` or `array`, or any of them followed by `[]` for a list.
- Required is `true` or `false`.

**`## Code`** is required, and must hold exactly one fenced code block, in `javascript` or `js`. It's parsed but not run by `check`, so a syntax error is reported early.

### How the code runs

- It's a CommonJS module, so `module.exports` must be a function. That function receives the call's input as an object, and may be async.
- A returned string is the result. Anything else is turned into JSON.
- A thrown error goes back to the agent as an error result, so it can see what went wrong.
- `require()` resolves from the tool's file, so the agent folder's `node_modules` works.
- It runs with the full access of the `agentschema run` process, so only run tools you trust.
- `run` loads a `.env` from the folder first, for the tool's settings. See [Sessions](sessions.md#env).

If a folder doesn't pass `check`, its custom tools don't run. `run` asks you for each result instead, and the same happens for a call to a tool it has no file for.

A host can refuse custom tools with `checkFiles(files, { customTools: false })`, because running users' code on a shared server isn't safe.

It compiles to:

```json
{
  "type": "custom",
  "name": "get_weather",
  "description": "Get the current weather for a city.",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "City name" },
      "days": { "type": "integer", "description": "How many days ahead" },
      "tags": { "type": "array", "items": { "type": "string" }, "description": "Labels to include" }
    },
    "required": ["city"]
  }
}
```

## Agentbook toolsets

Tools from a catalog that a host provides and runs itself, so a user can have them without writing code. The file picks which ones to turn on. `toolset` must match the file name.

```markdown path=tools/google_calendar.md
---
type: agentbook
toolset: google_calendar
---

## Tools

| Name | Enabled | Permission |
|---|---|---|
| `check_availability` | `true` | `always_allow` |
| `create_booking` | `true` | `always_ask` |
```

- The `## Tools` table is required, and a tool without a row is off, so a new tool in the catalog never reaches a deployed agent by itself.
- Permission is `always_allow` or `always_ask`. They reach the API as custom tools, which have no permission policy, so the host enforces it. A blank means `always_ask`.
- Each tool's name must be unique among custom tools and agentbook tools, which share one namespace at the API.

The host passes its catalog as an option:

```js
const toolsets = {
  google_calendar: {
    tools: [{ name: "check_availability", description: "…", input_schema: { type: "object", properties: {} } }],
  },
};
checkFiles(files, { toolsets });
```

Without a catalog, `check` warns that the file needs a host, and `deploy` refuses it. With one, an unknown toolset or tool is an error.

A tool in the catalog can also have `liveAllowed: false`, if it never runs on a live agent, or `safeForAnyone: true`, if anyone at all may use it, like one that only lists where the agent can post. These only change what `check` says about [channels](channels.md#who-can-reach-what) anyone can message. Enforcing `liveAllowed` is up to the host.

## Limits

An agent can have up to 256 tools at the API. agentschema counts each custom tool, plus one for everything else.
