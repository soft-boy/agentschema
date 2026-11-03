import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "claude-lock.json";

// Same layout as the lock file `ant apply` writes: one entry per file, keyed by "./<file>".
export function readLock(dir) {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${LOCK_FILE}: not valid JSON (${err.message})`);
  }
}

export function writeLock(dir, lock) {
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");
}

// Hash of a request body with keys sorted, so key order in the YAML doesn't count as a change.
export function hashBody(body) {
  return createHash("md5").update(canonicalJSON(body)).digest("hex");
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
