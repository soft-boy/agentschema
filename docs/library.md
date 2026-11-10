# Library

agentschema can run from your own code, on an agent held as a [file map](folder.md#file-maps), wherever you store it. This is how a host like a web app works: it keeps the files and the lock in a database, and gives each user their own API client.

```sh
npm install @soft-boy/agentschema
```

There are two entry points:

| Import | Where it runs | What it needs |
|---|---|---|
| `@soft-boy/agentschema` | Browser or Node | Only `yaml`, and no Node APIs |
| `@soft-boy/agentschema/node` | Node | The API client, hashing and the disk |

## A host, from start to finish

```js
import Anthropic from "@anthropic-ai/sdk";
import { checkFiles } from "@soft-boy/agentschema";
import { Conversation, deployFiles, startSession } from "@soft-boy/agentschema/node";

const client = new Anthropic({ apiKey: usersKey });
const checkOptions = { customTools: false, toolsets };

// Check, in the browser as they type, and again on the server.
const { errors, warnings, instance } = checkFiles(files, checkOptions);

// Deploy. saveLock runs as each resource is created, so a failure doesn't orphan anything.
const { plan, lock } = await deployFiles({
  files,
  lock: savedLock,
  client,
  checkOptions,
  saveLock: (next) => db.saveLock(next),
});

// Start a session, pinned to what was deployed.
const { session, notes } = await startSession({ instance, lock, client, title: "Test chat" });

// Have a conversation.
const conversation = new Conversation(client, session.id, {
  event: (event) => send(event),
  confirm: (event) => askTheUser(event),
  customToolResult: (event) => runTool(event),
});
await conversation.send("Hello");
```

`deployFiles` makes no calls when nothing has changed, so a host can run it before every session.

## Browser or Node: `@soft-boy/agentschema`

### Checking and reading

| Export | What it does |
|---|---|
| `checkFiles(files, options)` | Validates a file map. Returns `{ errors, warnings, instance }`, where `instance` is null if `agent.md` or `computer.md` can't be read. See [Checking](check.md) |
| `readInstance(files)` | Reads `agent.md` and `computer.md`, or `env.md`, its old name. Returns `{ agent, env, errors, warnings }`, and `env.file` says which name it was read from |
| `readTools(files)` | Returns `{ tools, errors }` |
| `readSkills(files)` | Returns `{ skills, errors }` |
| `readVaults(files)` | Returns `{ vaults, errors }` |
| `readChannels(files)` | Returns `{ channels, errors }` |
| `readSystemPrompt(files)` | Returns `{ parts, errors }`, where each part is `{ file, text }` from `system_prompt/`, in order |
| `systemPromptOf(instance)` | The whole system prompt: `agent.md`'s body, then `system_prompt/`. See [System prompt](system_prompt.md) |
| `parseMarkdown(text, file)` | Returns `{ data, body, raw }`, or throws `FileError` |
| `editFrontmatter(text, edit)` | Edits frontmatter through `edit(doc)`, a `yaml` Document, keeping its comments and the rest of the file. Returns the new text |

An `instance` holds `{ agent, env, tools, vaults, skills, channels }`.

### Compiling to the API

| Export | What it does |
|---|---|
| `agentBody(instance, skillRefs, options)` | The body sent to create an agent. Its `system` is `systemPromptOf(instance)` |
| `envBody(instance)` | The body sent to create an environment |
| `compileTools(tools, { toolsets })` | The agent's `tools` list |
| `skillRefs(skills, lock)` | The references to deployed skills, pinned to their versions |
| `vaultBody(vault)` | The body sent to create a vault |
| `credentialSettings(cred)` | A credential's settings, without secrets |
| `credentialCreateBody(cred, secrets)` | The body sent to create a credential, where `secrets` is `{ accessToken, expiresAt, refreshToken, clientSecret, secretValue }` |
| `secretsNeeded(cred)` | Whether it needs `{ refreshToken, clientSecret }` |
| `changedImmutableFields(cred, remoteAuth)` | Which [immutable fields](vaults.md#updating-a-credential) differ from what's deployed |
| `skillKey(skill)`, `vaultKey(vault)`, `credentialKey(cred)` | A resource's key in the lock |

### Writing files

| Export | What it does |
|---|---|
| `scaffold(answers)` | The files for a new agent, as `{ path: text }` |
| `defaultAnswers(name)` | The answers `scaffold` uses when a question is skipped |
| `builtInFile(names, enabled, permission)` | The pre-built tools' file. `permission` defaults to `auto` |
| `mcpToolsetFile({ name, tools, permission })` | An MCP server's tool file. `permission` defaults to `always_ask` |
| `agentbookTools(tools, toolsets)` | The agentbook tools a folder turns on, each with its effective `permission` |

### Channels

| Export | What it does |
|---|---|
| `channelSettings(channel)` | How a channel behaves, with every default filled in: `{ type, enabled, allow, respondTo, dedicatedChannels, sendTo, scope, expiresAfterMs, approvals, limits, greeting }` |
| `channelSystem(instance, channel)` | The system prompt for a conversation on this channel. Given only the agent, it leaves out `system_prompt/` |
| `durationMs(value)` | `"24h"` in milliseconds, or null if it isn't a length of time |
| `CHANNEL_TYPES` | What each type needs, including `CHANNEL_TYPES[type].secrets` |
| `ANYONE` | `"*"`, the value of `allow` for anyone |

See [Channels](channels.md).

### Scheduled tasks

| Export | What it does |
|---|---|
| `readScheduled(files)` | Returns `{ tasks, errors }` |
| `taskSettings(task)` | How a task behaves, with every default filled in: `{ name, schedule, timezone, enabled, budgetCents, description, message }` |
| `taskBody(task)` | The parts of its deployment that come from the file: `name`, `initial_events`, `schedule`, and `budget` and `description` if it has them |
| `taskKey(task)` | Its key in the lock |
| `cronProblem(expression)` | What's wrong with a cron expression, or null |
| `isTimeZone(value)` | Whether it's an IANA time zone |

See [Scheduled tasks](scheduled.md).

### Streaming

| Export | What it does |
|---|---|
| `textStream(write)` | Passes the agent's text to `write` as it streams in, and `handle(event)` returns true when it dealt with the event. Previews are best effort, so the complete message fills in whatever they missed |
| `agentMessageText(event)` | The text of a complete `agent.message` |

### Files and constants

- **Files:** `textOf`, `bytesOf`, `isIgnoredPath`, `pathsUnder`
- **Names:** `AGENT_FILE`, `COMPUTER_FILE`, `OLD_COMPUTER_FILE` (`env.md`), `TOOLS_DIR`, `SKILLS_DIR`, `SKILL_FILE`, `VAULTS_DIR`, `VAULT_FILE`, `CHANNELS_DIR`, `SCHEDULED_DIR`, `SYSTEM_PROMPT_DIR`, `TOOLSET_FILE`
- **Tool types:** `TOOLSET`, `MCP_TOOLSET`, `AGENTBOOK`, `PREBUILT_TOOLS`, `POLICIES`
- **Credential types:** `MCP_OAUTH`, `ENV_VAR`, `CREDENTIAL_TYPES`, `SECRET_FIELDS`, `TOKEN_ENDPOINT_AUTH`
- **Other:** `MODELS`, `NETWORKING`, `MAX_UPLOAD_BYTES`, `FileError`

## Node: `@soft-boy/agentschema/node`

### Deploying

**`deployFiles(options)`** creates or updates what's in a file map, and returns `{ plan, lock }`. See [Deploying and the lock](deploy.md).

| Option | What it does |
|---|---|
| `files` | The file map |
| `lock` | The last deploy's lock, or null for a first deploy |
| `client` | The API client |
| `dryRun` | Calls neither the API nor `saveLock` |
| `force` | Updates the agent even if it was changed elsewhere |
| `log` | Called with each line of progress |
| `saveLock` | Called with the lock as each resource exists, and may be async |
| `checkOptions` | What `checkFiles` takes |
| `pathOf` | How to show a file's path in messages |
| `scheduled` | `false` leaves scheduled tasks alone, for a copy of the agent that's only for trying it out |

`deploy(dir, options)` does the same for a folder on disk. `prepareLock(previous, client)` returns the lock to use, after checking it's for this API and moving an environment under `./env.md` to `./computer.md`. `environmentEntry(lock)` finds the environment's entry under either key, and `upgradeLock(lock)` does the move on its own. Failures are `DeployError`.

| Export | What it does |
|---|---|
| `pauseScheduled({ lock, client, saveLock })` | Pauses every scheduled task in a lock, such as when the agent goes offline. The next deploy unpauses the ones whose files say they're enabled |
| `archiveScheduled({ lock, client, saveLock })` | Archives them all, for good, such as before deleting the agent |

### Sessions

**`startSession(options)`** starts a session from a lock, and returns `{ session, notes }`. See [Sessions](sessions.md).

| Option | What it does |
|---|---|
| `instance` | The checked files, for finding the vaults to attach |
| `lock` | The lock |
| `client` | The API client |
| `agentVersion` | The version to pin, instead of the lock's latest |
| `system` | The system prompt for this session only, such as `channelSystem(instance, channel)` |
| `title` | The session's title |
| `budget` | The API's session budget, to cap what it can spend |
| `pathOf` | How to show a file's path in messages |

`openSession(dir, { client, sessionId })` does this for a folder on disk, and also notices files that changed since the last deploy. Failures are `SessionError`.

**`new Conversation(client, sessionId, ui)`** drives a session one turn at a time. `ui` answers what only a person can:

| Method | What it does |
|---|---|
| `ui.event(event)` | Shows an event, including the stream-only `event_start` and `event_delta` previews |
| `ui.confirm(event)` | Returns `{ result: "allow" \| "deny", deny_message }` for a paused tool call |
| `ui.customToolResult(event)` | Returns a string, or `{ text, isError }` |

`send(text)` returns the stop reason, or `"terminated"`. `interrupt()` asks the agent to stop at the next safe point, and `close()` stops listening.

### Credentials

| Export | What it does |
|---|---|
| `createCredential({ lock, vault, cred, secrets, client, saveLock, log })` | Creates a credential, and its vault if needed, on a lock object |
| `deleteCredential({ lock, cred, client, saveLock })` | Deletes one, if it has one. One that's already gone counts as deleted |

### Signing in to MCP servers

These work without a local browser, so a host can handle the callback itself:

| Export | What it does |
|---|---|
| `discover(serverUrl, { fetch })` | Finds the server's OAuth endpoints |
| `registerClient(endpoint, redirectUri, { fetch, clientName })` | Registers as a client. `clientName` is what the provider shows on its sign-in page |
| `authorizationRequest({ authorizationEndpoint, issuer, clientId, redirectUri, scope, resource })` | Returns `{ url, verifier, state }` |
| `exchangeCode({ tokenEndpoint, code, verifier, redirectUri, clientId, clientSecret, authMethod, resource }, { fetch })` | Returns `{ accessToken, refreshToken, expiresAt, scope }` |

Failures are `OAuthError`, a kind of `DeployError`.

### Listing MCP tools

| Export | What it does |
|---|---|
| `listMcpTools(url, { fetch, token, clientName })` | The names of a server's tools, sorted, or null if it won't say |
| `listedMcpToolset(files, url, options)` | The tool file for that server with its tools listed, as `{ path, text }`, or null if there's nothing to change |

### On disk

| Export | What it does |
|---|---|
| `check(dir, options)` | `checkFiles` for a folder |
| `readFolder(dir)` | Reads a folder into a file map, as bytes |
| `updateFrontmatter(file, edit)` | `editFrontmatter` on a file |
| `readLock(dir)`, `writeLock(dir, lock)` | The lock file |
| `hashBody(body)`, `skillFingerprint(skill)` | What the lock's hashes are made from |
| `LOCK_FILE` | `claude-lock.json` |

## Keeping separate copies

Nothing in agentschema assumes one deployment per folder. A host can keep several locks for one set of files, such as one for testing and one for a live page, so that nothing done in testing changes what's live:

- Give each copy its own lock, so each has its own agent and environment.
- Change the frontmatter it sends for one copy, so they're easy to tell apart at the runtime.
- Share skills and vaults by copying those entries between locks. Each copy pins its own skill version.

A lock belongs to one API key's workspace, so a host should key locks by which API key they were made with. Don't derive that key from your own encryption key, or rotating it will orphan every agent's lock.
