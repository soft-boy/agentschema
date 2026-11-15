import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lock } from "../lib/instance.ts";
import type { Skill } from "../lib/skills.ts";

export const LOCK_FILE = "claude-lock.json";

// Same layout as the lock file `ant apply` writes: one entry per file, keyed by "./<file>".
export function readLock(dir: string): Lock | null {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${LOCK_FILE}: not valid JSON (${(err as Error).message})`);
  }
}

export function writeLock(dir: string, lock: Lock): void {
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");
}

// What's hashed into the lock for a skill: each [path, sha256] of its files.
export interface SkillFingerprint {
  files: [rel: string, sha256: string][];
}

// What's hashed into the lock for a skill: each file's path and contents, so any change makes a
// new version.
export function skillFingerprint(skill: Pick<Skill, "files">): SkillFingerprint {
  return { files: skill.files.map((f): [string, string] => [f.rel, createHash("sha256").update(f.bytes).digest("hex")]) };
}

// Hash of a request body with keys sorted, so key order in the YAML doesn't count as a change.
export function hashBody(body: unknown): string {
  return createHash("md5").update(canonicalJSON(body)).digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
