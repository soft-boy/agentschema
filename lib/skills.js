import { bytesOf, isIgnoredPath, pathsUnder, textOf } from "./files.js";
import { FileError, parseMarkdown } from "./markdown.js";

export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// Reads skills/: each folder is a skill, with a SKILL.md at its top and any other files it needs,
// at any depth. Hidden files and node_modules are left out. Skills are sorted by name. No skills/
// folder means no skills.
// Returns { skills, errors }; a skill that can't be read has an entry in errors.
export function readSkills(files) {
  if (SKILLS_DIR in files) return { skills: [], errors: [`${SKILLS_DIR}: not a directory`] };

  const folders = new Map();
  const errors = [];
  for (const file of pathsUnder(files, SKILLS_DIR)) {
    const [, name, ...rest] = file.split("/");
    if (rest.length === 0) {
      if (name.endsWith(".md")) errors.push(`${file}: each skill is a folder, like ${SKILLS_DIR}/my-skill/${SKILL_FILE}`);
      continue;
    }
    if (!folders.has(name)) folders.set(name, []);
    folders.get(name).push({ rel: rest.join("/"), bytes: bytesOf(files[file]) });
  }

  const skills = [];
  for (const [name, skillFiles] of folders) {
    const path = `${SKILLS_DIR}/${name}`;
    // Exact names only, so a skill behaves the same on a case-sensitive file system.
    const main = skillFiles.find((f) => f.rel === SKILL_FILE);
    if (!main) {
      const wrongCase = skillFiles.find((f) => f.rel.toLowerCase() === SKILL_FILE.toLowerCase());
      errors.push(`${path}: missing ${SKILL_FILE}${wrongCase ? ` (found ${wrongCase.rel}; the name must be uppercase)` : ""}`);
      continue;
    }
    try {
      const parsed = parseMarkdown(textOf(main.bytes), `${path}/${SKILL_FILE}`);
      skills.push({ name, path, file: `${path}/${SKILL_FILE}`, files: skillFiles, ...parsed });
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
      errors.push(err.message);
    }
  }
  return { skills, errors };
}

// The lock file key for a skill.
export const skillKey = (skill) => `./${skill.path}`;

// The agent's references to the skills deployed from this folder, pinned to their versions, so
// that a session runs exactly what deploy last sent.
export function skillRefs(skills = [], lock) {
  return skills
    .map((skill) => lock?.resources?.[skillKey(skill)])
    .filter(Boolean)
    .map((entry) => ({ type: "custom", skill_id: entry.id, version: entry.version }));
}
