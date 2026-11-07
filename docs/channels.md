# `channels/`

Places people can talk to the agent, such as Telegram, SMS, email, Slack or Discord. Each `.md` file directly in `channels/` is a channel, named after the file, so an agent can have two Telegram bots.

**Status:** a draft. `check` validates all six types. [Agentbook](https://tryagentbook.com) connects `telegram`, `discord` and `email`, and nothing connects the others yet.

```markdown path=channels/telegram.md
---
type: telegram
allow: "*"
limits:
  messages_per_sender_per_hour: 30
---

You're chatting on Telegram. Keep replies short, and ask one question at a time.
```

## Who connects a channel

A channel needs a public address and a server that's always on, so the file only says how the channel should behave, and a **host** does the work. Anthropic doesn't receive these messages, and neither `run` nor `deploy` connects anything. `deploy` prints a note if a folder has channels.

For each message, a host receives it from the provider, starts or continues a session, and posts the reply back.

## The body

The body holds instructions for conversations on this channel. They're added after `agent.md`'s system prompt, for those sessions only, so one agent can write short texts over SMS and fuller replies by email. The two together can be up to the API's limit of 100,000 characters.

A session can override `system` for itself, so a channel doesn't need its own copy of the agent. `channelSystem(agent, channel)` builds the prompt, so that every host joins them the same way, and `startSession` takes it as `system`.

## Fields every channel has

| Field | Required | Default | What it does |
|---|---|---|---|
| `type` | Yes | | `telegram`, `twilio`, `sendgrid`, `email`, `slack` or `discord` |
| `allow` | Yes | | Who can talk to it: `"*"` for anyone, or a list |
| `enabled` | No | `true` | Turns the channel off without deleting it |
| `respond_to` | No | `[direct, mention]` | What it answers in group chats |
| `scope` | No | Depends on the type | What counts as one conversation |
| `expires_after` | No | `24h`, or `7d` for email | How long a quiet conversation lasts before the next message starts fresh |
| `approvals` | No | `deny` | What happens when a tool needs approval |
| `limits` | No | The host's own | Message caps |
| `greeting` | No | | The first message a new person gets, up to 1,000 characters |

A field that isn't listed for the channel's type is an error, so a typo like `approval: sender` doesn't silently do nothing.

### `allow`

`allow` has no default, so the author has to decide who gets in. It's `"*"` for anyone, with the quotes, or a list in the format of the channel's type. An empty list is an error: to turn a channel off, use `enabled: false`.

### `respond_to`

A list of `direct`, `mention`, `reply` or `all`, where `all` goes on its own. It only applies to channels with group chats, which are Telegram, Slack and Discord. Elsewhere it's a warning.

### `scope`

| Scope | One conversation per |
|---|---|
| `sender` | Person |
| `thread` | Thread, such as an email chain |
| `room` | Group chat or channel, shared by everyone in it |

### `expires_after`

A number followed by `m`, `h` or `d`, like `30m`, `24h` or `7d`.

### `approvals`

| Value | Meaning |
|---|---|
| `deny` | A tool that needs approval is refused |
| `sender` | The person chatting approves it |

`approvals: sender` with `allow: "*"` is an error, because it would let anyone approve tools. Email only has `deny`, since it has no buttons, and a sender's address can be forged.

### `limits`

| Field | Meaning |
|---|---|
| `messages_per_sender_per_hour` | How much one person can send |
| `messages_per_day` | How much the whole channel can receive |
| `messages_sent_per_hour` | How many messages the agent can post through [`send_to`](#posting-on-its-own) |

Each is a whole number above 0. Every message is paid for by the agent's owner, so a public channel should have limits, and a host should enforce its own as well.

## Types

Each type has its own fields, its own format for `allow`, and its own secrets. Values that look like numbers need quotes, or YAML reads them as numbers.

| Type | Scopes (first is the default) | Approvals | Group chats |
|---|---|---|---|
| `telegram` | `sender`, `room` | `deny`, `sender` | Yes |
| `twilio` | `sender` | `deny`, `sender` | No |
| `sendgrid` | `thread`, `sender` | `deny` | No |
| `email` | `thread`, `sender` | `deny` | No |
| `slack` | `thread`, `sender`, `room` | `deny`, `sender` | Yes |
| `discord` | `sender`, `room` | `deny`, `sender` | Yes |

### `telegram`

| | |
|---|---|
| **Extra fields** | None |
| **`allow`** | A numeric user ID in quotes, or an `@username` |
| **Secrets** | `bot_token` |

An `@username` gets a warning, because usernames can be given up and reclaimed by someone else.

### `twilio`

SMS or WhatsApp.

```markdown path=channels/sms.md
---
type: twilio
transport: sms
from: "+14155550123"
allow: ["+14155550199"]
approvals: sender
---

You're texting over SMS. Use plain text, and keep replies under 300 characters.
```

| | |
|---|---|
| **`transport`** | Required. `sms` or `whatsapp` |
| **`from`** | Required. The phone number to send from, like `"+14155550123"` |
| **`allow`** | Phone numbers in the same format |
| **Secrets** | `account_sid`, `auth_token` |

### `sendgrid`

Email.

```markdown path=channels/email.md
---
type: sendgrid
address: help@agent.example.com
from_name: Front desk
allow: ["*@example.com"]
---

You're replying by email, so write in full sentences and sign off with your name.
```

| | |
|---|---|
| **`address`** | Required. The address it receives and replies from |
| **`from_name`** | The name replies come from |
| **`allow`** | Email addresses, or `*@` and a domain |
| **Secrets** | `api_key` |

A sender's address can be forged, so a list here isn't proof of who's writing. Don't give an email channel tools that act for you without asking.

### `email`

Email at an address the host gives the agent, such as Agentbook's `<agent>@agent.tryagentbook.com`. The host sends and receives the email itself, so there's no account to connect.

```markdown path=channels/inbox.md
---
type: email
from_name: Sarah
allow: "*"
---

You're replying by email, so write a complete reply in full sentences, and sign off with your name.
```

| | |
|---|---|
| **`address`** | The address, if the host lets you choose it or checks it. Otherwise the host fills it in |
| **`from_name`** | The name replies come from |
| **`allow`** | Email addresses, or `*@` and a domain |
| **Secrets** | None |

As with `sendgrid`, a sender's address can be forged, so a host should only answer email whose sender it can verify, such as by DKIM or DMARC.

### `slack`

```markdown path=channels/team.md
---
type: slack
channels: [C012AB3CD]
allow: [U012AB3CD]
respond_to: [mention]
---

You're in a team's Slack. Reply in the thread, and keep it brief.
```

| | |
|---|---|
| **`channels`** | The channel IDs it may reply in, like `C012AB3CD` |
| **`allow`** | Member IDs, like `U012AB3CD` |
| **Secrets** | `bot_token`, `signing_secret` |

### `discord`

People can talk to a Discord agent with a slash command, by DM, and in a server by mentioning it or replying to it. A slash command only needs a webhook, and the rest needs a host that keeps a live connection to Discord.

```markdown path=channels/server.md
---
type: discord
application_id: "123456789012345678"
public_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
guilds: ["123456789012345678"]
command: ask
allow: "*"
---

You're answering a slash command on Discord, so keep it under 2,000 characters.
```

| | |
|---|---|
| **`application_id`** | Required. The Discord application's ID |
| **`public_key`** | Required. The application's 64-character public key, which isn't secret |
| **`guilds`** | The server IDs it may reply in |
| **`channels`** | The channel IDs it may answer mentions and replies in, within those servers |
| **`dedicated_channels`** | Channels it has to itself. See below |
| **`send_to`** | Channels it may post in on its own. See [Posting on its own](#posting-on-its-own) |
| **`command`** | The slash command's name, like `ask` |
| **`allow`** | Numeric user IDs in quotes |
| **Secrets** | `bot_token` |

To give an agent a channel of its own, list it under `dedicated_channels`. It answers every message there, in one conversation that everyone shares, and it's told who said what. `respond_to` still applies everywhere else, so this agent also answers DMs, mentions and replies:

```markdown path=channels/front-desk.md
---
type: discord
application_id: "223456789012345678"
public_key: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
dedicated_channels: ["123456789012345678"]
respond_to: [direct, mention, reply]
allow: "*"
---

You're on Discord, and one channel there is your own, so everyone in it is talking to you.
```

To answer only in those channels, and nowhere else, write `respond_to: []`. `channels` doesn't limit dedicated channels. Reading every message in a channel needs Discord's Message Content Intent, which is on the bot's page in the Developer Portal. Without it, Discord only shows a bot the messages that mention it.

## Posting on its own

An agent normally only answers. `send_to` lists the places it may also post in on its own, such as an announcements channel. It's on Discord, where it lists channel IDs:

```markdown path=channels/server.md
---
type: discord
application_id: "123456789012345678"
public_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
send_to: ["223456789012345678"]
limits:
  messages_sent_per_hour: 10
allow: "*"
---
```

The list does nothing by itself. The host gives the agent a tool that posts, such as Agentbook's `messaging` toolset, and the list is what that tool is limited to. A place can only be in one file's `send_to`, so it's clear which bot posts there. The bot needs to be in that server, with permission to see the channel and send messages there, but it doesn't need the Message Content Intent.

## Secrets

A channel's secrets never go in its file, and naming one there is an error. They also can't go in a [vault](vaults.md), because vault secrets are write-only, and a host has to read them back to send a reply.

Instead, each type declares what it needs in `CHANNEL_TYPES[type].secrets`, and the host asks for those and keeps them itself, encrypted. A host should key them by the channel's name, since an agent can have two channels of one type.

## Who can reach what

If anyone can message a channel, `check` warns about tools that act through the owner's sign-ins and connections without asking:

```
channels/telegram.md: anyone can message this channel, and these tools can run
without asking, through your sign-ins and connections: bank.pay, calendar.book
```

That means MCP tools set to `always_allow` or `auto`, and agentbook tools set to `always_allow`. Pre-built tools don't count, because they run in the session's own container. A host's tool with `liveAllowed: false` doesn't count either, because channels run on the live agent, and nor does one with `safeForAnyone: true`, such as one that only lists where the agent can post. A tool that posts through `send_to` does count, because anyone could have it post in those channels.

## Other rules

- A channel's name is its file name, and may use lowercase letters, digits, `_` and `-`, up to 64 characters, because hosts use it in addresses.
- `channels/` is flat, so a folder inside it is an error. Files that aren't `.md` are ignored.
- Two files can't claim the same Twilio number and transport, the same email address, or the same Discord application. Email files that leave `address` to the host don't count.

## What doesn't belong in the file

- **Secrets,** as above.
- **Webhook addresses and their signing secrets:** the host generates them.
- **Runtime data,** such as which sender maps to which session: that goes in the host's database.

## Notes for hosts

Read a channel with `readChannels(files)`, and get its behavior with `channelSettings(channel)`, which fills in the defaults, so that every host agrees on them. See [Library](library.md).

- Treat a channel like a public page: run the deployed version, on the same copy of the agent, and enforce your own limits.
- Acknowledge a provider's webhook quickly and do the work afterwards, because providers retry, and a retry shouldn't start a second reply.
- Verify each provider's signature on incoming messages before trusting them. For email, also check the sender passed DKIM or DMARC, or someone can write as anyone, and the agent replies to whoever they named.
- Post only in the places a channel's `send_to` lists, and only while the channel is enabled. Turn mentions off, so that an agent can't be talked into pinging everyone.
- Visitors should only see the agent's words, not tool calls or error details.
- Check each provider's own docs when you build for it. Each has its own rules on setup, message length and sign-up, such as registering to send SMS in the US, or receiving email on a subdomain.
