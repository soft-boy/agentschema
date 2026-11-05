import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTool } from "../src/chat.js";
import { check } from "../src/check.js";
import { agentBody } from "../lib/instance.js";

const dir = fileURLToPath(new URL("../examples/calendar-agent", import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const tools = Object.fromEntries(check(dir).instance.tools.map((t) => [t.name, t]));
const CALENDAR = "bookings@group.calendar.google.com";

const calls = [];
let reply = () => ({});
let tokenRequests = 0;
const realFetch = globalThis.fetch;

before(() => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "agentschema-key-")), "key.json");
  writeFileSync(keyFile, JSON.stringify({
    client_email: "agent@project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  }));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
  process.env.GOOGLE_CALENDAR_ID = CALENDAR;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") {
      tokenRequests++;
      const [header, claims, signature] = new URLSearchParams(init.body).get("assertion").split(".");
      const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url");
      assert.equal(valid, true);
      const { iss, scope, aud } = JSON.parse(Buffer.from(claims, "base64url"));
      assert.equal(iss, "agent@project.iam.gserviceaccount.com");
      assert.equal(aud, "https://oauth2.googleapis.com/token");
      assert.deepEqual(scope.split(" "), ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"]);
      return Response.json({ access_token: "token_1", expires_in: 3600 });
    }
    assert.equal(init.headers.authorization, "Bearer token_1");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), body });
    const result = reply();
    if (result === null) return new Response(null, { status: 204 });
    return Response.json(result, { status: result.error ? result.error.code : 200 });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CALENDAR_ID;
});

const run = async (name, input) => {
  const { text, isError } = await runTool(tools[name], input);
  if (isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const event = { id: "e1", summary: "Haircut", start: { dateTime: "2026-11-05T14:00:00-08:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-11-05T14:30:00-08:00" } };
const eventsPath = `/calendar/v3/calendars/${CALENDAR}/events`;

test("the calendar agent's six tools compile, with no code sent", () => {
  const custom = agentBody(check(dir).instance).tools.filter((t) => t.type === "custom");
  assert.deepEqual(custom.map((t) => t.name), ["cancel_booking", "check_availability", "create_booking", "get_booking", "list_bookings", "update_booking"]);
  assert.doesNotMatch(JSON.stringify(custom), /calendarApi|private_key/);
});

test("check_availability returns the calendar's busy times", async () => {
  const busy = [{ start: "2026-11-05T10:00:00Z", end: "2026-11-05T11:00:00Z" }];
  reply = () => ({ calendars: { [CALENDAR]: { busy } } });
  const result = await run("check_availability", { from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z" });
  assert.deepEqual(result.busy, busy);
  assert.deepEqual(calls.at(-1).body.items, [{ id: CALENDAR }]);
  assert.equal(tokenRequests, 1);
});

test("check_availability fails rather than calling an unreadable calendar free", async () => {
  reply = () => ({ calendars: { [CALENDAR]: { errors: [{ domain: "global", reason: "notFound" }], busy: [] } } });
  const result = await run("check_availability", { from: "2026-11-05T00:00:00Z", to: "2026-11-06T00:00:00Z" });
  assert.match(result.error, /couldn't read the calendar's busy times: notFound/);
});

test("list_bookings and get_booking read the calendar", async () => {
  reply = () => ({ items: [event] });
  const { bookings, more } = await run("list_bookings", { search: "hair" });
  assert.deepEqual(bookings[0], { id: "e1", title: "Haircut", start: event.start.dateTime, end: event.end.dateTime, time_zone: "America/Los_Angeles", description: null, location: null });
  assert.equal(more, false);
  const { method, path, query } = calls.at(-1);
  assert.equal(method, "GET");
  assert.equal(path, eventsPath);
  assert.equal(query.q, "hair");
  assert.equal(query.singleEvents, "true");
  assert.ok(query.timeMin);

  reply = () => event;
  assert.equal((await run("get_booking", { id: "e1" })).title, "Haircut");
  assert.equal(calls.at(-1).path, `${eventsPath}/e1`);
});

test("create_booking and update_booking send only what they're given, with no attendees", async () => {
  reply = () => event;
  await run("create_booking", { title: "Haircut", start: "2026-11-05T14:00:00", end: "2026-11-05T14:30:00", time_zone: "America/Los_Angeles" });
  assert.equal(calls.at(-1).method, "POST");
  assert.equal(calls.at(-1).path, eventsPath);
  assert.deepEqual(calls.at(-1).body, {
    summary: "Haircut",
    start: { dateTime: "2026-11-05T14:00:00", timeZone: "America/Los_Angeles" },
    end: { dateTime: "2026-11-05T14:30:00", timeZone: "America/Los_Angeles" },
  });

  await run("update_booking", { id: "e1", location: "Main St" });
  assert.equal(calls.at(-1).method, "PATCH");
  assert.equal(calls.at(-1).path, `${eventsPath}/e1`);
  assert.deepEqual(calls.at(-1).body, { location: "Main St" });
});

test("cancel_booking deletes from the calendar, and API errors reach the agent", async () => {
  reply = () => null;
  assert.equal(await run("cancel_booking", { id: "e/1" }), "Cancelled e/1.");
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).path, `${eventsPath}/e/1`);

  reply = () => ({ error: { code: 403, message: "You need to have writer access to this calendar." } });
  assert.match((await run("create_booking", { title: "x", start: "a", end: "b" })).error, /Google Calendar said 403: You need to have writer access/);
});

test("a missing setting is reported to the agent", async () => {
  const saved = process.env.GOOGLE_CALENDAR_ID;
  delete process.env.GOOGLE_CALENDAR_ID;
  assert.match((await run("get_booking", { id: "e1" })).error, /GOOGLE_CALENDAR_ID isn't set/);
  process.env.GOOGLE_CALENDAR_ID = saved;
});
