import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPES, channelSettings, channelSystem, durationMs, readChannels } from "../lib/channels.js";
import { checkFiles } from "../lib/check.js";
import { agentBody } from "../lib/instance.js";
import { AGENT_MD, ENV_MD, PREBUILT_MD } from "./helpers.js";

const BASE = { "agent.md": AGENT_MD, "env.md": ENV_MD };
const file = (front, body = "") => `---\n${front}\n---\n\n${body}`;
const checked = (files, options) => checkFiles({ ...BASE, ...files }, options);
const errorsFor = (front, body) => checked({ "channels/c.md": file(front, body) }).errors;
const warningsFor = (front) => checked({ "channels/c.md": file(front) }).warnings;
const KEY = "a".repeat(64);
const ID = "123456789012345678";

const VALID = {
  telegram: 'type: telegram\nallow: "*"',
  twilio: 'type: twilio\ntransport: sms\nfrom: "+14155550123"\nallow: ["+14155550199"]\napprovals: sender',
  whatsapp: 'type: twilio\ntransport: whatsapp\nfrom: "+14155550123"\nallow: "*"',
  sendgrid: 'type: sendgrid\naddress: help@agent.example.com\nfrom_name: Help\nallow: ["me@example.com", "*@example.com"]',
  slack: "type: slack\nchannels: [C012AB3CD]\nallow: [U012AB3CD]\nrespond_to: [mention]",
  discord: `type: discord\napplication_id: "${ID}"\npublic_key: ${KEY}\nguilds: ["${ID}"]\ncommand: ask\nallow: ["${ID}"]`,
};

for (const [name, front] of Object.entries(VALID)) {
  test(`a ${name} channel is valid, and it reaches the check's instance`, () => {
    const { errors, warnings, instance } = checked({ "channels/mine.md": file(front, "Be brief.") });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(instance.channels[0].name, "mine");
    assert.equal(instance.channels[0].body, "Be brief.");
  });
}

test("an agent doesn't need any channels", () => {
  const { errors, instance } = checked({});
  assert.deepEqual(errors, []);
  assert.deepEqual(instance.channels, []);
});

test("channels never reach the API", () => {
  const without = checked({ "tools/agent_toolset_20260401.md": PREBUILT_MD }).instance;
  const withOne = checked({ "tools/agent_toolset_20260401.md": PREBUILT_MD, "channels/c.md": file(VALID.telegram, "Be brief.") }).instance;
  assert.deepEqual(agentBody(withOne), agentBody(without));
});

test("channels/ is a flat folder of .md files", () => {
  assert.deepEqual(readChannels({ channels: "text" }).errors, ["channels: not a directory"]);
  const { channels, errors } = readChannels({
    "channels/a.md": file(VALID.telegram),
    "channels/notes.txt": "not a channel",
    "channels/.hidden.md": "not a channel",
    "channels/sub/b.md": file(VALID.telegram),
    "channels/sub/c.md": file(VALID.telegram),
  });
  assert.deepEqual(channels.map((c) => c.name), ["a"]);
  assert.deepEqual(errors, ["channels/sub: channels/ holds channel files, not folders"]);
});

test("a file that can't be parsed is an error", () => {
  assert.match(checked({ "channels/c.md": "no frontmatter" }).errors[0], /channels\/c\.md: must start with YAML frontmatter/);
});

test("a channel's name has to work in addresses", () => {
  assert.match(checked({ "channels/Sales Bot.md": file(VALID.telegram) }).errors[0], /may only use lowercase letters/);
  assert.deepEqual(checked({ "channels/sales-bot_2.md": file(VALID.telegram) }).errors, []);
});

test("type is required, and must be one we know", () => {
  assert.match(errorsFor('allow: "*"')[0], /`type` must be `telegram`, `twilio`, `sendgrid`, `slack`, `discord`/);
  assert.match(errorsFor('type: fax\nallow: "*"')[0], /`type` must be/);
  assert.match(errorsFor('type: constructor\nallow: "*"')[0], /`type` must be/);
});

test("allow has no default, so the author has to choose", () => {
  assert.match(errorsFor("type: telegram")[0], /`allow` is required/);
  assert.match(errorsFor("type: telegram\nallow: []")[0], /has nobody in it/);
  assert.match(errorsFor("type: telegram\nallow: me")[0], /must be "\*", or a list/);
  assert.match(errorsFor('type: telegram\nallow: ["*"]')[0], /on its own/);
});

test("who's allowed has to look right for the channel", () => {
  assert.match(errorsFor("type: telegram\nallow: [someone]")[0], /a numeric user ID or an @username/);
  assert.match(errorsFor('type: twilio\ntransport: sms\nfrom: "+14155550123"\nallow: ["415-555-0199"]')[0], /a phone number/);
  assert.match(errorsFor("type: sendgrid\naddress: a@b.co\nallow: [nobody]")[0], /an email address/);
  assert.match(errorsFor("type: slack\nallow: [someone]")[0], /a member ID/);
  assert.match(errorsFor(`type: discord\napplication_id: "${ID}"\npublic_key: ${KEY}\nallow: ["7"]`)[0], /a numeric user ID/);
});

test("numbers YAML would change get a hint to quote them", () => {
  const errors = errorsFor("type: twilio\ntransport: sms\nfrom: +14155550123\nallow: [+14155550199]");
  assert.equal(errors.length, 2);
  for (const error of errors) assert.match(error, /put it in quotes/);
});

test("telegram IDs work, and usernames get a warning because they change hands", () => {
  assert.deepEqual(errorsFor('type: telegram\nallow: ["123456"]'), []);
  assert.match(warningsFor('type: telegram\nallow: ["@someone"]')[0], /can change hands/);
});

test("approvals are refused for anyone at all, and on email", () => {
  assert.match(errorsFor('type: telegram\nallow: "*"\napprovals: sender')[0], /would let anyone approve tools/);
  assert.match(errorsFor('type: telegram\nallow: ["1"]\napprovals: maybe')[0], /`approvals` must be `deny` or `sender`/);
  assert.match(errorsFor('type: sendgrid\naddress: a@b.co\nallow: ["a@b.co"]\napprovals: sender')[0], /`approvals` must be `deny` on sendgrid/);
  assert.deepEqual(errorsFor('type: telegram\nallow: ["1"]\napprovals: sender'), []);
});

test("respond_to is checked, and flagged where it means nothing", () => {
  assert.match(errorsFor('type: slack\nallow: "*"\nrespond_to: everyone')[0], /`respond_to` must be a list/);
  assert.match(errorsFor('type: slack\nallow: "*"\nrespond_to: []')[0], /`respond_to` must be a list/);
  assert.match(errorsFor('type: slack\nallow: "*"\nrespond_to: [loud]')[0], /`respond_to` must be a list/);
  assert.match(errorsFor('type: slack\nallow: "*"\nrespond_to: [all, mention]')[0], /list it on its own/);
  assert.deepEqual(errorsFor('type: slack\nallow: "*"\nrespond_to: [all]'), []);
  assert.match(warningsFor('type: sendgrid\naddress: a@b.co\nallow: "*"\nrespond_to: [all]')[0], /no effect on sendgrid/);
});

test("scope depends on the channel", () => {
  assert.deepEqual(errorsFor('type: slack\nallow: "*"\nscope: room'), []);
  assert.match(errorsFor('type: twilio\ntransport: sms\nfrom: "+14155550123"\nallow: "*"\nscope: room')[0], /`scope` must be `sender` on twilio/);
  assert.match(errorsFor('type: telegram\nallow: "*"\nscope: thread')[0], /`sender` or `room` on telegram/);
});

test("the other shared fields are checked", () => {
  assert.match(errorsFor('type: telegram\nallow: "*"\nenabled: maybe')[0], /`enabled` must be true or false/);
  for (const value of ["soon", "0h", "24", "1.5h", "-1d"]) {
    assert.match(errorsFor(`type: telegram\nallow: "*"\nexpires_after: ${value}`)[0], /`expires_after` must be/, value);
  }
  assert.match(errorsFor('type: telegram\nallow: "*"\nlimits: 5')[0], /`limits` must be a mapping/);
  assert.match(errorsFor('type: telegram\nallow: "*"\nlimits: {messages_per_week: 5}')[0], /unknown field `limits.messages_per_week`/);
  assert.match(errorsFor('type: telegram\nallow: "*"\nlimits: {messages_per_day: 0}')[0], /a whole number above 0/);
  assert.match(errorsFor('type: telegram\nallow: "*"\ngreeting: 5')[0], /`greeting` must be text/);
  assert.match(errorsFor(`type: telegram\nallow: "*"\ngreeting: ${"a".repeat(1001)}`)[0], /the limit is 1,000/);
});

test("each type's own fields are checked", () => {
  const twilio = errorsFor('type: twilio\nallow: "*"');
  assert.ok(twilio.some((e) => e.includes("`transport` is required")));
  assert.ok(twilio.some((e) => e.includes("`from` is required")));
  assert.match(errorsFor('type: twilio\ntransport: fax\nfrom: "+14155550123"\nallow: "*"')[0], /`transport` must be `sms` or `whatsapp`/);
  assert.match(errorsFor('type: sendgrid\naddress: nope\nallow: "*"')[0], /`address` must be an email address/);
  assert.match(errorsFor('type: slack\nchannels: general\nallow: "*"')[0], /`channels` must be a list/);
  assert.match(errorsFor('type: slack\nchannels: [general]\nallow: "*"')[0], /a channel ID/);
  const discord = errorsFor(`type: discord\napplication_id: "1"\npublic_key: short\ncommand: "Ask Me"\nguilds: ["1"]\nallow: "*"`);
  assert.equal(discord.length, 4);
});

test("a field for another type, or a typo, is an error", () => {
  assert.match(errorsFor('type: telegram\nallow: "*"\nfrom: "+14155550123"')[0], /unknown field `from`/);
  assert.match(errorsFor('type: telegram\nallow: "*"\napproval: sender')[0], /unknown field `approval`/);
});

test("a channel's secrets can't go in its file", () => {
  assert.match(errorsFor('type: telegram\nallow: "*"\nbot_token: abc')[0], /`bot_token` doesn't go in the file/);
  assert.match(errorsFor('type: slack\nallow: "*"\nsigning_secret: abc')[0], /`signing_secret` doesn't go in the file/);
  for (const [secret, what] of [
    [`123456789:${"A".repeat(35)}`, /Telegram bot token/],
    [`SG.${"a".repeat(22)}.${"b".repeat(43)}`, /SendGrid API key/],
    [`AC${"0".repeat(32)}`, /Twilio SID/],
    [`M${"a".repeat(23)}.abcdef.${"b".repeat(27)}`, /Discord bot token/],
    ["xoxb-1234567890-abc", /Slack token/],
  ]) {
    assert.match(errorsFor(VALID.telegram, `Use ${secret} to reply.`)[0], what);
  }
});

test("two channels can't claim the same address", () => {
  const twice = (front) => checked({ "channels/a.md": file(front), "channels/b.md": file(front) }).errors;
  assert.match(twice(VALID.twilio)[0], /channels\/b\.md: channels\/a\.md already uses this/);
  assert.match(twice(VALID.discord)[0], /already uses this/);
  assert.match(twice('type: sendgrid\naddress: a@b.co\nallow: "*"')[0], /already uses this/);
  assert.deepEqual(twice(VALID.telegram), []);
  const sameNumber = checked({ "channels/a.md": file(VALID.twilio), "channels/b.md": file(VALID.whatsapp) });
  assert.deepEqual(sameNumber.errors, []);
});

test("the channel's text counts towards the system prompt's limit", () => {
  assert.deepEqual(errorsFor(VALID.telegram, "a".repeat(99_000)), []);
  assert.match(errorsFor(VALID.telegram, "a".repeat(100_000))[0], /more than 100,000 characters/);
});

const MCP = (rows, front = "") => `---\ntype: mcp_toolset\nmcp_server_name: bank\n${front}---\n\n${rows ? `## Tools\n\n| Name | Enabled | Permission |\n|---|---|---|\n${rows}\n` : ""}`;
const AGENT_WITH_BANK = AGENT_MD.replace("model:", "mcp_servers:\n  - {type: url, name: bank, url: 'https://bank.example.com/mcp'}\nmodel:");
const ENV_WITH_MCP = ENV_MD.replace("type: limited", "type: limited\n    allow_mcp_servers: true");
const withBank = (tool, channel = VALID.telegram) => checkFiles({ "agent.md": AGENT_WITH_BANK, "env.md": ENV_WITH_MCP, "tools/bank.md": tool, "channels/c.md": file(channel) });

test("an open channel warns about tools that act for the owner without asking", () => {
  const { errors, warnings } = withBank(MCP("| pay | true | always_allow |\n| read | true | auto |\n| list | true | always_ask |\n| off | false | always_allow |\n| blank | true | |"));
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /channels\/c\.md: anyone can message this channel/);
  assert.match(warnings[0], /bank\.pay, bank\.read$/);
});

test("a server with no table uses its default, which is to ask", () => {
  assert.deepEqual(withBank(MCP("")).warnings, []);
  assert.match(withBank(MCP("", "default_config:\n  permission_policy: {type: always_allow}\n")).warnings[0], /every tool in bank/);
  assert.deepEqual(withBank(MCP("", "default_config:\n  enabled: false\n  permission_policy: {type: always_allow}\n")).warnings, []);
  assert.match(withBank(MCP("| pay | true | |", "default_config:\n  permission_policy: {type: always_allow}\n")).warnings[0], /bank\.pay/);
});

test("the warning is only for channels anyone can reach", () => {
  const allowed = MCP("| pay | true | always_allow |");
  assert.deepEqual(withBank(allowed, 'type: telegram\nallow: ["1"]').warnings, []);
  assert.deepEqual(withBank(allowed, 'type: telegram\nallow: "*"\nenabled: false').warnings, []);
});

test("pre-built tools don't count, since they run in the session's own container", () => {
  assert.deepEqual(checked({ "tools/agent_toolset_20260401.md": PREBUILT_MD, "channels/c.md": file(VALID.telegram) }).warnings, []);
});

test("agentbook tools count, unless they never run on a live agent", () => {
  const tool = "---\ntype: agentbook\ntoolset: calendar\n---\n\n## Tools\n\n| Name | Enabled | Permission |\n|---|---|---|\n| book | true | always_allow |\n| cancel | true | always_allow |\n| check | true | always_ask |\n";
  const schema = { type: "object", properties: {} };
  const toolsets = { calendar: { tools: [{ name: "book", description: "b", input_schema: schema }, { name: "cancel", description: "c", input_schema: schema, liveAllowed: false }, { name: "check", description: "k", input_schema: schema }] } };
  const { errors, warnings } = checked({ "tools/calendar.md": tool, "channels/c.md": file(VALID.telegram) }, { toolsets });
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /calendar\.book$/);
});

test("settings fill in each type's defaults, so hosts agree on them", () => {
  const settings = (front) => channelSettings(readChannels({ "channels/c.md": file(front) }).channels[0]);
  assert.deepEqual(settings(VALID.telegram), { type: "telegram", enabled: true, allow: "*", respondTo: ["direct", "mention"], scope: "sender", expiresAfterMs: 86_400_000, approvals: "deny", limits: {}, greeting: null });
  assert.equal(settings('type: sendgrid\naddress: a@b.co\nallow: "*"').scope, "thread");
  assert.equal(settings('type: slack\nallow: "*"').scope, "thread");
  const custom = settings('type: slack\nallow: [U012AB3CD]\nenabled: false\nscope: room\nrespond_to: [all]\nexpires_after: 30m\napprovals: sender\nlimits: {messages_per_day: 5}\ngreeting: Hi');
  assert.deepEqual(custom, { type: "slack", enabled: false, allow: ["U012AB3CD"], respondTo: ["all"], scope: "room", expiresAfterMs: 1_800_000, approvals: "sender", limits: { messages_per_day: 5 }, greeting: "Hi" });
});

test("the system prompt is the agent's, then the channel's", () => {
  assert.equal(channelSystem({ body: "Agent." }, { body: "Channel." }), "Agent.\n\nChannel.");
  assert.equal(channelSystem({ body: "Agent." }, { body: "" }), "Agent.");
  assert.equal(channelSystem({ body: "" }, { body: "Channel." }), "Channel.");
});

test("durations read in minutes, hours and days", () => {
  assert.equal(durationMs("30m"), 1_800_000);
  assert.equal(durationMs("2h"), 7_200_000);
  assert.equal(durationMs("7d"), 604_800_000);
  assert.equal(durationMs("24"), null);
  assert.equal(durationMs(24), null);
});

test("every type says which secrets its host has to ask for", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([type, { secrets }]) => [type, secrets])), {
    telegram: ["bot_token"],
    twilio: ["account_sid", "auth_token"],
    sendgrid: ["api_key"],
    slack: ["bot_token", "signing_secret"],
    discord: ["bot_token"],
  });
});

test("a Discord agent can have a channel of its own, where it answers everything", () => {
  const front = `type: discord\napplication_id: "${ID}"\npublic_key: ${KEY}\nchannels: ["${ID}"]\nrespond_to: [direct, all]\nscope: room\nallow: "*"`;
  assert.match(errorsFor(front)[0] ?? "", /list it on its own/);
  const own = front.replace("[direct, all]", "[all]");
  assert.deepEqual(errorsFor(own), []);
  assert.deepEqual(warningsFor(own), []);
  assert.equal(channelSettings(readChannels({ "channels/c.md": file(own) }).channels[0]).scope, "room");
  assert.match(errorsFor(own.replace(`channels: ["${ID}"]`, "channels: [general]"))[0], /a numeric channel ID/);
});

test("on Discord, respond_to means something now", () => {
  assert.deepEqual(warningsFor(`type: discord\napplication_id: "${ID}"\npublic_key: ${KEY}\nrespond_to: [direct, reply]\nallow: "*"`), []);
});

test("answering everything without saying where gets a warning", () => {
  const front = `type: discord\napplication_id: "${ID}"\npublic_key: ${KEY}\nrespond_to: [all]\nallow: "*"`;
  assert.match(warningsFor(front)[0], /every message in every channel/);
  assert.match(warningsFor('type: slack\nallow: "*"\nrespond_to: [all]')[0], /every message in every channel/);
  assert.deepEqual(warningsFor('type: telegram\nallow: "*"\nrespond_to: [all]'), []);
});
