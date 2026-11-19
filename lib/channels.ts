import { type FileMap, pathsUnder, textOf } from "./files.ts";
import { AGENT_FILE } from "./instance.ts";
import { type SystemPromptPart, systemPromptOf } from "./system-prompt.ts";
import { FileError, type Frontmatter, type MarkdownFile, parseMarkdown } from "./markdown.ts";
import { AGENTBOOK, type AgentbookCatalog, MCP_TOOLSET, type Tool, type ToolRow } from "./tools.ts";

// A channel is a place people can talk to an agent, like Telegram or SMS. Its file says how the channel
// should behave, and a host that's always on (Agentbook, say) does the connecting, because Anthropic
// doesn't receive these messages and `run` shouldn't either. So nothing here is sent to the API.
export const CHANNELS_DIR = "channels";
export const ANYONE = "*";
// In `send_to`, everyone who has messaged the agent on the channel.
export const CONTACTS = "contacts";

const DEFAULT_RESPOND_TO = ["direct", "mention"];
const DEFAULT_EXPIRES_AFTER = "24h";
// An email thread can go quiet for days and still be one conversation.
const EMAIL_EXPIRES_AFTER = "7d";
const RESPOND_TO = ["direct", "mention", "reply", "all"];
const LIMITS = ["messages_per_sender_per_hour", "messages_per_day", "messages_sent_per_hour"];
const SHARED_FIELDS = ["type", "enabled", "allow", "respond_to", "scope", "expires_after", "approvals", "limits", "greeting", "send_to"];
const MAX_GREETING = 1000;
const MAX_SYSTEM_PROMPT = 100_000;

// A channel file, named after the file: channels/<name>.md.
export interface Channel extends MarkdownFile {
  file: string;
  name: string;
}

// What's wrong with a field's value, or null.
type Check = (value: unknown) => string | null;

export interface ChannelField {
  required?: boolean;
  check: Check;
}

export interface ChannelType {
  secrets: string[];
  scopes: string[];
  approvals: string[];
  hasGroups: boolean;
  expiresAfter?: string;
  allow: Check;
  // Where the agent can send on its own, when the channel can: what each place in `send_to` must be, and
  // whether it can be "contacts" or "*". See checkSendTo.
  sendTo?: { place: Check; contacts: boolean; anyone: boolean };
  fields: Record<string, ChannelField>;
  identity?: (data: Frontmatter) => string | null;
}

// How a channel behaves, with the defaults filled in: what channelSettings returns.
export interface ChannelSettings {
  type: string;
  enabled: boolean;
  allow: typeof ANYONE | string[];
  respondTo: string[];
  dedicatedChannels: string[];
  sendTo: string[];
  scope: string;
  expiresAfterMs: number | null;
  approvals: string;
  limits: Record<string, number>;
  greeting: string | null;
}

export interface ReadChannelsResult {
  channels: Channel[];
  errors: string[];
}

export interface CheckChannelsOptions {
  agent?: Pick<MarkdownFile, "body">;
  systemPrompt?: SystemPromptPart[];
  tools?: Tool[];
  toolsets?: AgentbookCatalog;
}

// What channelSystem takes: an instance (or its agent and system prompt), or an agent's file alone.
export type ChannelSystemSource =
  | { agent: Pick<MarkdownFile, "body">; systemPrompt?: SystemPromptPart[] }
  | { agent?: undefined; body: string };

type Report = (msg: string) => void;

const code = (value: unknown): string => `\`${value}\``;
const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

// Phone numbers and long IDs read as numbers in YAML if they aren't quoted, which loses the +.
const matches = (pattern: RegExp, what: string): Check => (value) => {
  if (typeof value === "string" && pattern.test(value)) return null;
  return `must be ${what}${typeof value === "number" ? " (put it in quotes, or YAML reads it as a number)" : ""}`;
};
const oneOf = (...values: unknown[]): Check => (value) => (values.includes(value) ? null : `must be ${values.map(code).join(" or ")}`);
const text: Check = (value) => (typeof value === "string" && value.trim() !== "" ? null : "must be text");
const listOf = (check: Check): Check => (value) => {
  if (!Array.isArray(value)) return "must be a list";
  return value.map(check).find(Boolean) ?? null;
};

const PHONE = /^\+[1-9]\d{6,14}$/;
const DISCORD_ID = /^\d{17,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_ALLOW = matches(/^(\*|[^\s@]+)@[^\s@]+\.[^\s@]+$/, "an email address, or *@ and a domain");

// What differs between channels. Each `secrets` entry is something the host asks for and keeps: never
// the file, and never a vault, because a vault's secrets can't be read back to send a reply. The first
// of `scopes` is the default. `identity` is what two files in one agent can't share, where that's known.
// `expiresAfter` is the default for `expires_after`, where it isn't the usual one.
export const CHANNEL_TYPES: Record<string, ChannelType> = {
  telegram: {
    secrets: ["bot_token"],
    scopes: ["sender", "room"],
    approvals: ["deny", "sender"],
    hasGroups: true,
    allow: matches(/^(\d+|@[A-Za-z0-9_]{5,32})$/, "a numeric user ID or an @username"),
    // A bot can only message a chat that has started it, so there's no one else to send to.
    sendTo: { place: matches(/^-?\d+$/, "a numeric chat ID"), contacts: true, anyone: false },
    fields: {},
  },
  twilio: {
    secrets: ["account_sid", "auth_token"],
    scopes: ["sender"],
    approvals: ["deny", "sender"],
    hasGroups: false,
    allow: matches(PHONE, "a phone number like +14155550123"),
    sendTo: { place: matches(PHONE, "a phone number like +14155550123"), contacts: true, anyone: true },
    fields: {
      transport: { required: true, check: oneOf("sms", "whatsapp") },
      from: { required: true, check: matches(PHONE, "a phone number like +14155550123") },
    },
    identity: ({ transport, from }) => `${transport} ${from}`,
  },
  sendgrid: {
    secrets: ["api_key"],
    scopes: ["thread", "sender"],
    // An email has no buttons, and its sender can be forged.
    approvals: ["deny"],
    hasGroups: false,
    expiresAfter: EMAIL_EXPIRES_AFTER,
    allow: EMAIL_ALLOW,
    sendTo: { place: EMAIL_ALLOW, contacts: true, anyone: true },
    fields: {
      address: { required: true, check: matches(EMAIL, "an email address") },
      from_name: { check: text },
    },
    identity: ({ address }) => address,
  },
  // Email at an address the host gives the agent, such as Agentbook's, so the host sends and receives it
  // and there's nothing to connect. `address` can be left out, for the host to fill in.
  email: {
    secrets: [],
    scopes: ["thread", "sender"],
    approvals: ["deny"],
    hasGroups: false,
    expiresAfter: EMAIL_EXPIRES_AFTER,
    allow: EMAIL_ALLOW,
    sendTo: { place: EMAIL_ALLOW, contacts: true, anyone: true },
    fields: {
      address: { check: matches(EMAIL, "an email address") },
      from_name: { check: text },
    },
    identity: ({ address }) => address ?? null,
  },
  slack: {
    secrets: ["bot_token", "signing_secret"],
    scopes: ["thread", "sender", "room"],
    approvals: ["deny", "sender"],
    hasGroups: true,
    allow: matches(/^[UW][A-Z0-9]{2,}$/, "a member ID like U012AB3CD"),
    fields: {
      channels: { check: listOf(matches(/^[CG][A-Z0-9]{2,}$/, "a channel ID like C012AB3CD")) },
    },
  },
  discord: {
    secrets: ["bot_token"],
    scopes: ["sender", "room"],
    approvals: ["deny", "sender"],
    hasGroups: true,
    allow: matches(DISCORD_ID, "a numeric user ID"),
    sendTo: { place: matches(DISCORD_ID, "a numeric channel ID"), contacts: false, anyone: false },
    fields: {
      application_id: { required: true, check: matches(DISCORD_ID, "a numeric application ID") },
      public_key: { required: true, check: matches(/^[0-9a-f]{64}$/, "the 64-character public key") },
      guilds: { check: listOf(matches(DISCORD_ID, "a numeric server ID")) },
      channels: { check: listOf(matches(DISCORD_ID, "a numeric channel ID")) },
      dedicated_channels: { check: listOf(matches(DISCORD_ID, "a numeric channel ID")) },
      command: { check: matches(/^[a-z0-9_-]{1,32}$/, "a slash command's name, like ask") },
    },
    identity: ({ application_id: id }) => id,
  },
};

// Reads channels/: each .md file directly inside it is a channel named after the file, so an agent can
// have two Telegram bots. No channels/ folder means no channels.
// Returns { channels, errors }; a file that can't be parsed has an entry in errors.
export function readChannels(files: FileMap): ReadChannelsResult {
  if (CHANNELS_DIR in files) return { channels: [], errors: [`${CHANNELS_DIR}: not a directory`] };

  const channels: Channel[] = [];
  const errors: string[] = [];
  const reportedFolders = new Set<string>();
  for (const file of pathsUnder(files, CHANNELS_DIR)) {
    const [, item, ...rest] = file.split("/");
    if (rest.length > 0) {
      const folder = `${CHANNELS_DIR}/${item}`;
      if (!reportedFolders.has(folder)) errors.push(`${folder}: ${CHANNELS_DIR}/ holds channel files, not folders`);
      reportedFolders.add(folder);
    } else if (item.endsWith(".md")) {
      try {
        channels.push({ file, name: item.slice(0, -".md".length), ...parseMarkdown(textOf(files[file]!), file) });
      } catch (err) {
        if (!(err instanceof FileError)) throw err;
        errors.push(err.message);
      }
    }
  }
  return { channels, errors };
}

// Errors and warnings for the channel files, in check's format. `agent` and `tools` are what the channel
// is attached to, and `toolsets` is the catalog behind `type: agentbook` files.
export function checkChannels(
  channels: Channel[],
  { agent = { body: "" }, systemPrompt = [], tools = [], toolsets }: CheckChannelsOptions = {},
  errors: string[] = [],
  warnings: string[] = [],
): { errors: string[]; warnings: string[] } {
  const unasked = toolsThatRunUnasked(tools, toolsets);
  const identities = new Map<string, string>();
  // Where each place in a `send_to` came from: only one bot can post there, so it's clear which one does.
  const postedTo = new Map<string, string>();

  for (const channel of channels) {
    const err: Report = (msg) => errors.push(`${channel.file}: ${msg}`);
    const warn: Report = (msg) => warnings.push(`${channel.file}: ${msg}`);
    const { data, name } = channel;

    // Hosts use the name in webhook addresses and to store the channel's secrets.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) err("the name may only use lowercase letters, digits, _ and -, up to 64 characters");

    const type: ChannelType | null = Object.hasOwn(CHANNEL_TYPES, data.type) ? CHANNEL_TYPES[data.type]! : null;
    if (!type) {
      err(`\`type\` must be ${Object.keys(CHANNEL_TYPES).map(code).join(", ")}`);
      continue;
    }

    checkAllow(data, type, err, warn);
    checkShared(data, type, err, warn);
    checkSendTo(data, type, err, warn);
    for (const [field, { required, check }] of Object.entries(type.fields)) {
      if (data[field] === undefined) {
        if (required) err(`\`${field}\` is required`);
        continue;
      }
      const problem = check(data[field]);
      if (problem) err(`\`${field}\` ${problem}`);
    }

    for (const key of Object.keys(data)) {
      if (type.secrets.includes(key)) err(`\`${key}\` doesn't go in the file; whatever hosts the channel asks for it and keeps it`);
      else if (!SHARED_FIELDS.includes(key) && !Object.hasOwn(type.fields, key)) err(`unknown field \`${key}\``);
    }

    if (channelSystem({ agent, systemPrompt }, channel).length > MAX_SYSTEM_PROMPT) {
      err(`with ${AGENT_FILE}'s system prompt, this comes to more than ${MAX_SYSTEM_PROMPT.toLocaleString("en-US")} characters; the limit is the API's`);
    }

    const hasRequiredFields = Object.entries(type.fields).every(([field, { required }]) => !required || data[field] !== undefined);
    const own = type.identity && hasRequiredFields ? type.identity(data) : null;
    if (own !== null) {
      const identity = `${data.type} ${own}`;
      if (identities.has(identity)) err(`${identities.get(identity)} already uses this`);
      else identities.set(identity, channel.file);
    }

    // A Discord channel can only be in one file's `send_to`. An address or number can be in several.
    if (data.type === "discord" && Array.isArray(data.send_to)) {
      for (const place of data.send_to) {
        if (typeof place !== "string") continue;
        if (postedTo.has(place)) err(`\`send_to\`: ${place} is already in ${postedTo.get(place)}, and only one bot can post there`);
        else postedTo.set(place, channel.file);
      }
    }

    if (data.allow === ANYONE && data.enabled !== false && unasked.length > 0) {
      warn(`anyone can message this channel, and these tools can run without asking, through your sign-ins and connections: ${unasked.join(", ")}`);
    }
  }
  return { errors, warnings };
}

function checkAllow({ allow, approvals }: Frontmatter, type: ChannelType, err: Report, warn: Report): void {
  if (allow === undefined || allow === null) return err(`\`allow\` is required: "${ANYONE}" for anyone, or a list of who can use it`);
  if (allow === ANYONE) {
    if (approvals === "sender") err(`\`approvals: sender\` would let anyone approve tools, so it needs \`allow\` to be a list`);
    return;
  }
  if (!Array.isArray(allow)) return err(`\`allow\` must be "${ANYONE}", or a list of who can use it`);
  if (allow.length === 0) return err("`allow` has nobody in it; list who can use it, or set `enabled: false`");
  for (const entry of allow) {
    if (entry === ANYONE) return err(`write \`allow: "${ANYONE}"\` on its own, not in a list`);
    const problem = type.allow(entry);
    if (problem) err(`\`allow\`: ${JSON.stringify(entry)} ${problem}`);
    else if (typeof entry === "string" && entry.startsWith("@")) warn(`\`allow\`: ${entry} can change hands, because Telegram usernames can be given up and reclaimed; a numeric user ID is safer`);
  }
}

// `send_to`: where the agent may send on its own, through a host's tool. A list of places, which can
// include "contacts", for everyone who has messaged the agent on the channel, or "*" for anywhere, alone.
// Email takes "*@" and a domain, for anyone there.
function checkSendTo({ send_to: sendTo, type: name, allow }: Frontmatter, type: ChannelType, err: Report, warn: Report): void {
  if (sendTo === undefined) return;
  if (!type.sendTo) return err(`\`send_to\` isn't available on ${name} yet`);
  const { place, contacts, anyone } = type.sendTo;
  if (sendTo === ANYONE || sendTo === CONTACTS) {
    if (sendTo === ANYONE && !anyone) return err(`\`send_to: "${ANYONE}"\` isn't available on ${name}${contacts ? `; use ${CONTACTS} for everyone who's messaged it` : "; list where it can send"}`);
    if (sendTo === CONTACTS && !contacts) return err(`\`send_to: ${CONTACTS}\` isn't available on ${name}; list where it can send`);
  } else if (!Array.isArray(sendTo)) {
    return err(`\`send_to\` must be a list of where it can send${anyone ? `, or "${ANYONE}"` : ""}`);
  } else {
    for (const entry of sendTo) {
      if (entry === ANYONE) return err(anyone ? `write \`send_to: "${ANYONE}"\` on its own, not in a list` : `\`send_to\` can't be "${ANYONE}" on ${name}`);
      if (entry === CONTACTS) {
        if (!contacts) err(`\`send_to\`: ${CONTACTS} isn't available on ${name}`);
        continue;
      }
      const problem = place(entry);
      if (problem) err(`\`send_to\`: ${JSON.stringify(entry)} ${problem}${contacts ? `, or ${CONTACTS}` : ""}`);
    }
  }
  if (sendTo === ANYONE && name === "twilio") {
    warn(`\`send_to: "${ANYONE}"\` lets the agent text any number. Texting people who haven't agreed to hear from you can break US law and carrier rules, so ${CONTACTS} or a list is safer`);
  } else if (sendTo === ANYONE && allow === ANYONE) {
    warn(`anyone can message this channel, and \`send_to: "${ANYONE}"\` lets the agent send anywhere; a host should only let the owner's own conversations send to places that aren't listed`);
  }
}

function checkShared(data: Frontmatter, type: ChannelType, err: Report, warn: Report): void {
  if (data.enabled !== undefined && typeof data.enabled !== "boolean") err("`enabled` must be true or false");

  // An agent can answer only in channels it has to itself, and nowhere else.
  const onlyDedicated = Array.isArray(data.respond_to) && data.respond_to.length === 0 && data.dedicated_channels?.length > 0;
  if (data.respond_to !== undefined && !onlyDedicated) {
    const list = data.respond_to;
    if (!Array.isArray(list) || list.length === 0 || list.some((v) => !RESPOND_TO.includes(v))) {
      err(`\`respond_to\` must be a list of ${RESPOND_TO.map(code).join(", ")}`);
    } else if (list.includes("all") && list.length > 1) {
      err("`respond_to`: `all` already covers the others, so list it on its own");
    } else if (!type.hasGroups) {
      warn(`\`respond_to\` has no effect on ${data.type}`);
    } else if (list.includes("all") && Object.hasOwn(type.fields, "channels") && data.channels === undefined) {
      warn("`respond_to: [all]` answers every message in every channel it can see, and each one costs you a turn; list the ones you mean under `channels`");
    }
  }

  if (data.scope !== undefined && !type.scopes.includes(data.scope)) err(`\`scope\` must be ${type.scopes.map(code).join(" or ")} on ${data.type}`);

  if (data.expires_after !== undefined && durationMs(data.expires_after) === null) {
    err("`expires_after` must be a length of time like 30m, 24h or 7d");
  }

  if (data.approvals !== undefined && !type.approvals.includes(data.approvals)) {
    err(`\`approvals\` must be ${type.approvals.map(code).join(" or ")} on ${data.type}`);
  }

  if (data.limits !== undefined) {
    if (!isObject(data.limits)) err("`limits` must be a mapping");
    else {
      for (const [key, value] of Object.entries(data.limits)) {
        if (!LIMITS.includes(key)) err(`unknown field \`limits.${key}\`; use ${LIMITS.map(code).join(" or ")}`);
        else if (!Number.isInteger(value) || (value as number) < 1) err(`\`limits.${key}\` must be a whole number above 0`);
      }
      if (data.limits.messages_sent_per_hour !== undefined && data.send_to === undefined) {
        warn("`limits.messages_sent_per_hour` has no effect without `send_to`");
      }
    }
  }

  if (data.greeting !== undefined) {
    if (text(data.greeting)) err("`greeting` must be text");
    else if (data.greeting.length > MAX_GREETING) err(`\`greeting\` is ${data.greeting.length} characters; the limit is ${MAX_GREETING.toLocaleString("en-US")}`);
  }
}

// The tools that act through the owner's sign-ins and connections without anyone approving each call.
// Computer tools aren't here, since they run in the session's own container. In a toolset's table, a
// blank permission means the file's default, which for an MCP server is the API's default of asking.
function toolsThatRunUnasked(tools: Tool[], toolsets: AgentbookCatalog | undefined): string[] {
  const isOn = (row: ToolRow): boolean => row.enabled.toLowerCase() === "true";
  return tools.flatMap((tool) => {
    if (tool.data.type === MCP_TOOLSET) {
      const defaults = tool.data.default_config;
      const fallback = defaults?.permission_policy?.type ?? "always_ask";
      if (tool.rows?.length) {
        return tool.rows.filter((row) => isOn(row) && (row.permission || fallback) !== "always_ask").map((row) => `${tool.name}.${row.name}`);
      }
      return fallback !== "always_ask" && defaults?.enabled !== false ? [`every tool in ${tool.name}`] : [];
    }
    if (tool.data.type === AGENTBOOK) {
      const catalog = toolsets?.[tool.data.toolset]?.tools;
      const definition = (row: ToolRow) => catalog?.find((t) => t.name === row.name);
      // A tool that never runs on a live agent can't run here, and one that's safe for anyone needn't be mentioned.
      const isOfNoConcern = (row: ToolRow) => definition(row)?.liveAllowed === false || definition(row)?.safeForAnyone === true;
      return (tool.rows ?? []).filter((row) => isOn(row) && row.permission === "always_allow" && !isOfNoConcern(row)).map((row) => `${tool.name}.${row.name}`);
    }
    return [];
  });
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// A length of time like 30m, 24h or 7d, in milliseconds, or null if it isn't one.
export function durationMs(value: unknown): number | null {
  const match = typeof value === "string" ? /^([1-9]\d*)([mhd])$/.exec(value) : null;
  return match ? Number(match[1]) * UNIT_MS[match[2]!]! : null;
}

// How a channel behaves, with the defaults filled in, so that every host agrees on them.
export function channelSettings({ data }: Pick<Channel, "data">): ChannelSettings {
  const type = CHANNEL_TYPES[data.type]!;
  return {
    type: data.type,
    enabled: data.enabled ?? true,
    allow: data.allow,
    respondTo: data.respond_to ?? DEFAULT_RESPOND_TO,
    dedicatedChannels: data.dedicated_channels ?? [],
    sendTo: data.send_to === undefined ? [] : Array.isArray(data.send_to) ? data.send_to : [data.send_to],
    scope: data.scope ?? type.scopes[0],
    expiresAfterMs: durationMs(data.expires_after ?? type.expiresAfter ?? DEFAULT_EXPIRES_AFTER),
    approvals: data.approvals ?? "deny",
    limits: data.limits ?? {},
    greeting: data.greeting ?? null,
  };
}

// Whether a channel's `send_to` lets the agent send to `to`, given whether `to` has messaged the agent
// on that channel before. Email addresses are compared without regard to case.
export function maySendTo({ sendTo }: Pick<ChannelSettings, "sendTo">, to: string, { isContact = false }: { isContact?: boolean } = {}): boolean {
  if (sendTo.includes(ANYONE)) return true;
  if (isContact && sendTo.includes(CONTACTS)) return true;
  const address = to.toLowerCase();
  return sendTo.some((place) => {
    if (place === CONTACTS || place === ANYONE) return false;
    if (place.startsWith("*@")) return address.endsWith(place.slice(1).toLowerCase());
    return place.includes("@") ? place.toLowerCase() === address : place === to;
  });
}

// The system prompt for a conversation on this channel: the agent's, then the channel's own instructions.
// A session can override `system` for itself, so a channel doesn't need its own copy of the agent.
// `instance` is what checkFiles returns, so the agent's prompt includes system_prompt/. An agent alone,
// as before, still works, with only agent.md's body.
export const channelSystem = (instance: ChannelSystemSource, channel: Pick<Channel, "body">): string =>
  [instance.agent ? systemPromptOf(instance) : instance.body, channel.body].filter(Boolean).join("\n\n");
