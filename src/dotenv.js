import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ENV_FILE_NAME = ".env";

// Parses KEY=VALUE lines. Returns { values, bad }: `bad` holds the numbers of lines that aren't
// valid, so they can be reported without showing what's on them.
export function parseEnvFile(text) {
  const values = {};
  const bad = [];
  for (const [index, raw] of text.replace(/^﻿/, "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const value = match && parseValue(match[2]);
    if (value === null || !match) bad.push(index + 1);
    else values[match[1]] = value;
  }
  return { values, bad };
}

// A quoted value, where double quotes understand \n and \", or a bare value up to a " #" comment.
// Returns null for a quote that isn't closed.
function parseValue(text) {
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    const end = quote === "'" ? text.indexOf("'", 1) : /(?<!\\)"/.exec(text.slice(1))?.index + 1;
    if (end === undefined || end < 1 || Number.isNaN(end)) return null;
    const inner = text.slice(1, end);
    return quote === "'" ? inner : inner.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return text.replace(/\s+#.*$/, "").trim();
}

// Loads a folder's .env into process.env, for code that runs on your side. A variable already
// set in the shell wins. A missing file is fine. Returns warnings to show.
export function loadEnvFile(dir, env = process.env) {
  let text;
  try {
    text = readFileSync(join(dir, ENV_FILE_NAME), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    return [`couldn't read ${ENV_FILE_NAME}: ${err.message}`];
  }
  const { values, bad } = parseEnvFile(text);
  for (const [name, value] of Object.entries(values)) {
    if (env[name] === undefined) env[name] = value;
  }
  return bad.map((line) => `${ENV_FILE_NAME}:${line}: not a KEY=VALUE line, so it was skipped`);
}
