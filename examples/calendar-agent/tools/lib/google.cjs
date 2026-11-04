// Logs in to Google as a service account and calls the Calendar API, for the tools in this folder.
// Runs on your side, with its settings in environment variables:
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service account's JSON key
//   GOOGLE_CALENDAR_ID              the calendar to use, shared with "Make changes to events"
const { createSign } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://www.googleapis.com/calendar/v3";
const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

function setting(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set`);
  return value;
}

const calendarId = () => setting("GOOGLE_CALENDAR_ID");

const base64url = (value) => Buffer.from(value).toString("base64url");

// An access token lasts an hour, so it's kept until shortly before then.
let cached = null;

async function accessToken() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const path = setting("GOOGLE_APPLICATION_CREDENTIALS").replace(/^~(?=\/)/, homedir());
  const key = JSON.parse(readFileSync(path, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({ iss: key.client_email, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 })),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the service account's login (${res.status}): ${body.error_description ?? body.error ?? "no access token"}`);
  }
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// Calls the Calendar API, and returns the parsed response.
async function calendarApi(method, path, { query, body } = {}) {
  const url = new URL(`${API_URL}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  const headers = { authorization: `Bearer ${await accessToken()}` };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Google Calendar said ${res.status}: ${parsed?.error?.message ?? text}`);
  return parsed;
}

// The path of an event on the calendar. Every tool that touches an event goes through here, so
// none can reach another calendar.
const eventsPath = (eventId) => {
  const base = `/calendars/${encodeURIComponent(calendarId())}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
};

// What a tool reports about an event.
const booking = (event) => ({
  id: event.id,
  title: event.summary ?? null,
  start: event.start?.dateTime ?? event.start?.date ?? null,
  end: event.end?.dateTime ?? event.end?.date ?? null,
  time_zone: event.start?.timeZone ?? null,
  description: event.description ?? null,
  location: event.location ?? null,
});

// A start or end time, in the form the API takes.
const when = (dateTime, timeZone) => (timeZone ? { dateTime, timeZone } : { dateTime });

module.exports = { booking, calendarApi, calendarId, eventsPath, when };
