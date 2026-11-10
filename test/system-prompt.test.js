import assert from "node:assert/strict";
import { test } from "node:test";
import { channelSystem, readChannels } from "../lib/channels.js";
import { checkFiles } from "../lib/check.js";
import { agentBody } from "../lib/instance.js";
import { comparePaths } from "../lib/files.js";
import { readSystemPrompt, systemPromptOf } from "../lib/system-prompt.js";
import { deployFiles } from "../src/deploy.js";
import { readFolder } from "../src/folder.js";
import { AGENT_MD, ENV_MD, instance } from "./helpers.js";

const BASE = { "agent.md": AGENT_MD, "env.md": ENV_MD };
const checked = (files) => checkFiles({ ...BASE, ...files });
const promptOf = (files) => agentBody(checked(files).instance).system;

test("files in system_prompt/ go after agent.md's body, in the order tree lists them", () => {
  // The same names as this `tree`, as it lists them on a Mac:
  //   02.txt, 10.txt, A-intro.md, C/d.md, a/B/c.md, a/b.md, a/x.md, a.md, b.md, c.md
  const names = ["b.md", "a/x.md", "a.md", "C/d.md", "c.md", "a/B/c.md", "a/b.md", "A-intro.md", "02.txt", "10.txt"];
  const files = Object.fromEntries(names.map((name) => [`system_prompt/${name}`, `This is ${name}.`]));
  const order = ["02.txt", "10.txt", "A-intro.md", "C/d.md", "a/B/c.md", "a/b.md", "a/x.md", "a.md", "b.md", "c.md"];
  assert.deepEqual(readSystemPrompt(files).parts.map((part) => part.file), order.map((name) => `system_prompt/${name}`));
  assert.equal(promptOf(files), ["You are a helpful coding assistant.", ...order.map((name) => `This is ${name}.`)].join("\n\n"));
});

test("tree's order goes character by character, and puts a folder's files where the folder sorts", () => {
  assert.deepEqual(["b", "a.md", "a/z", "10", "2", "B"].sort(comparePaths), ["10", "2", "B", "a/z", "a.md", "b"]);
});

test("each file is taken as written, trimmed, and empty ones add nothing", () => {
  const files = { "system_prompt/one.md": "\n\n---\nnot: frontmatter\n---\n\nOne.\n\n", "system_prompt/two.md": "  \n", "system_prompt/three.md": "Three." };
  assert.equal(promptOf(files), "You are a helpful coding assistant.\n\n---\nnot: frontmatter\n---\n\nOne.\n\nThree.");
});

test("system_prompt/ alone can be the whole prompt, and without it nothing changes", () => {
  const empty = { "agent.md": "---\nname: Helper\nmodel: claude-opus-5-5\n---\n" };
  assert.equal(promptOf({ ...empty, "system_prompt/all.md": "Everything." }), "Everything.");
  assert.equal(promptOf(empty), undefined);
  assert.equal(promptOf({}), "You are a helpful coding assistant.");
  assert.equal(systemPromptOf({ agent: { body: "Just this." } }), "Just this.");
});

test("hidden files and node_modules are left out, and a file that isn't text is an error", () => {
  assert.equal(promptOf({ "system_prompt/.notes.md": "Hidden.", "system_prompt/node_modules/x.md": "Package.", "system_prompt/ok.md": "Ok." }), "You are a helpful coding assistant.\n\nOk.");
  assert.match(checked({ "system_prompt/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) }).errors[0], /system_prompt\/logo\.png: isn't a text file/);
  assert.match(checked({ system_prompt: "x" }).errors[0], /system_prompt: not a directory/);
});

test("the limit is on the whole system prompt, and secrets can't hide in its files", () => {
  const long = "x".repeat(60_000);
  assert.deepEqual(checked({ "system_prompt/a.md": long }).errors, []);
  assert.match(checked({ "system_prompt/a.md": long, "system_prompt/b.md": long }).errors[0], /^agent\.md and system_prompt\/: the system prompt is 120,0\d\d characters; the limit is 100,000/);
  assert.match(checked({ "agent.md": AGENT_MD.replace("You are", `${"y".repeat(100_001)} You are`) }).errors.find((e) => e.includes("limit")), /^agent\.md: the system prompt is/);
  assert.match(checked({ "system_prompt/keys.md": `Use sk-ant-${"a".repeat(20)}.` }).errors[0], /system_prompt\/keys\.md: looks like it contains an Anthropic API key/);
});

test("a channel's instructions go after the whole prompt, and count towards its limit", () => {
  const files = { ...BASE, "system_prompt/rules.md": "Be kind.", "channels/telegram.md": '---\ntype: telegram\nallow: "*"\n---\n\nKeep it short.\n' };
  const { instance } = checkFiles(files);
  const [channel] = readChannels(files).channels;
  assert.equal(channelSystem(instance, channel), "You are a helpful coding assistant.\n\nBe kind.\n\nKeep it short.");
  // Given just the agent, as before, it's agent.md's body.
  assert.equal(channelSystem(instance.agent, channel), "You are a helpful coding assistant.\n\nKeep it short.");
  const crowded = checkFiles({ ...files, "system_prompt/long.md": "x".repeat(99_000), "channels/telegram.md": `---\ntype: telegram\nallow: "*"\n---\n\n${"y".repeat(2000)}\n` });
  assert.ok(crowded.errors.some((error) => /channels\/telegram\.md: with agent\.md's system prompt, this comes to more than 100,000 characters/.test(error)));
});

test("reading a folder from disk takes system_prompt/, at any depth", () => {
  const dir = instance({ ...BASE, "system_prompt/intro.md": "Intro.", "system_prompt/deep/er/rules.md": "Rules." });
  const files = readFolder(dir);
  assert.ok("system_prompt/deep/er/rules.md" in files);
  assert.equal(promptOf(files), "You are a helpful coding assistant.\n\nRules.\n\nIntro.");
});

test("changing a file in system_prompt/ updates the agent when deployed", async () => {
  const calls = [];
  let version = 0;
  const resource = (kind) => ({
    create: async (body) => (calls.push([`${kind}.create`, body]), { id: `${kind}_1`, version: ++version, ...body }),
    retrieve: async (id) => ({ id, version, metadata: {} }),
    update: async (id, body) => (calls.push([`${kind}.update`, body]), { id, version: ++version, ...body }),
  });
  const client = { baseURL: "https://api.anthropic.com", beta: { agents: resource("agent"), environments: resource("env") } };
  const { lock } = await deployFiles({ files: { ...BASE, "system_prompt/rules.md": "Be kind." }, client });
  await deployFiles({ files: { ...BASE, "system_prompt/rules.md": "Be kind." }, client, lock });
  assert.equal(calls.filter(([name]) => name === "agent.update").length, 0);
  await deployFiles({ files: { ...BASE, "system_prompt/rules.md": "Be very kind." }, client, lock, force: true });
  const [, updated] = calls.find(([name]) => name === "agent.update");
  assert.equal(updated.system, "You are a helpful coding assistant.\n\nBe very kind.");
});
