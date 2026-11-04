import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileError, parseMarkdown } from "./markdown.js";

export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// Reads skills/: each folder is a skill, with a SKILL.md at its top and any other files it needs,
// at any depth. Hidden files and node_modules are left out. Skills are sorted by name. A missing
// skills/ folder means no skills.
// Returns { skills, errors }; a skill that can't be read has an entry in errors.
export function readSkills(dir) {
  const folder = join(dir, SKILLS_DIR);
  try {
    if (!statSync(folder).isDirectory()) return { skills: [], errors: [`${SKILLS_DIR}: not a directory`] };
  } catch {
    return { skills: [], errors: [] };
  }

  const skills = [];
  const errors = [];
  for (const entry of sorted(readdirSync(folder, { withFileTypes: true }))) {
    if (entry.name.startsWith(".")) continue;
    const path = `${SKILLS_DIR}/${entry.name}`;
    if (!entry.isDirectory()) {
      if (entry.name.endsWith(".md")) errors.push(`${path}: each skill is a folder, like ${SKILLS_DIR}/my-skill/${SKILL_FILE}`);
      continue;
    }

    const files = skillFiles(join(folder, entry.name), "");
    // Compare exact names: macOS file systems would otherwise open skill.md as SKILL.md.
    const main = files.find((f) => f.rel === SKILL_FILE);
    if (!main) {
      const wrongCase = files.find((f) => f.rel.toLowerCase() === SKILL_FILE.toLowerCase());
      errors.push(`${path}: missing ${SKILL_FILE}${wrongCase ? ` (found ${wrongCase.rel}; the name must be uppercase)` : ""}`);
      continue;
    }
    try {
      const parsed = parseMarkdown(main.bytes.toString("utf8"), `${path}/${SKILL_FILE}`);
      skills.push({ name: entry.name, path, file: `${path}/${SKILL_FILE}`, files, ...parsed });
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
    }
  }
  return { skills, errors };
}

function skillFiles(folder, prefix) {
  const files = [];
  for (const entry of sorted(readdirSync(folder, { withFileTypes: true }))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...skillFiles(join(folder, entry.name), `${rel}/`));
    else if (entry.isFile()) files.push({ rel, bytes: readFileSync(join(folder, entry.name)) });
  }
  return files;
}

const sorted = (entries) => entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// The lock file key for a skill.
export const skillKey = (skill) => `./${skill.path}`;

// What's hashed into the lock: each file's path and contents, so any change makes a new version.
export function skillFingerprint(skill) {
  return { files: skill.files.map((f) => [f.rel, createHash("sha256").update(f.bytes).digest("hex")]) };
}

// The agent's references to the skills deployed from this folder, pinned to their versions, so
// that a session runs exactly what deploy last sent.
export function skillRefs(skills = [], lock) {
  return skills
    .map((skill) => lock?.resources?.[skillKey(skill)])
    .filter(Boolean)
    .map((entry) => ({ type: "custom", skill_id: entry.id, version: entry.version }));
}
