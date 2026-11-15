import { type FileMap, bytesOf, isIgnoredPath, pathsUnder, textOf } from "./files.ts";
import type { Lock, LockEntry } from "./instance.ts";
import { FileError, type MarkdownFile, parseMarkdown } from "./markdown.ts";

export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// A file in a skill's folder: its path within the folder, and its contents.
export interface SkillFile {
  rel: string;
  bytes: Uint8Array;
}

// A folder in skills/, with its SKILL.md parsed. `path` is the folder (skills/name), `file` its SKILL.md.
export interface Skill extends MarkdownFile {
  name: string;
  path: string;
  file: string;
  files: SkillFile[];
}

export interface ReadSkillsResult {
  skills: Skill[];
  errors: string[];
}

// What an agent's `skills` list holds for a deployed skill.
export interface SkillRef {
  type: "custom";
  skill_id: string;
  version: string;
}

// Reads skills/: each folder is a skill, with a SKILL.md at its top and any other files it needs,
// at any depth. Hidden files and node_modules are left out. Skills are sorted by name. No skills/
// folder means no skills.
// Returns { skills, errors }; a skill that can't be read has an entry in errors.
export function readSkills(files: FileMap): ReadSkillsResult {
  if (SKILLS_DIR in files) return { skills: [], errors: [`${SKILLS_DIR}: not a directory`] };

  const folders = new Map<string, SkillFile[]>();
  const errors: string[] = [];
  for (const file of pathsUnder(files, SKILLS_DIR)) {
    const [, name, ...rest] = file.split("/");
    if (rest.length === 0) {
      if (name.endsWith(".md")) errors.push(`${file}: each skill is a folder, like ${SKILLS_DIR}/my-skill/${SKILL_FILE}`);
      continue;
    }
    if (!folders.has(name)) folders.set(name, []);
    folders.get(name)!.push({ rel: rest.join("/"), bytes: bytesOf(files[file]) });
  }

  const skills: Skill[] = [];
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
export const skillKey = (skill: Pick<Skill, "path">): string => `./${skill.path}`;

// The agent's references to the skills deployed from this folder, pinned to their versions, so
// that a session runs exactly what deploy last sent.
export function skillRefs(skills: Pick<Skill, "path">[] = [], lock?: Lock | null): SkillRef[] {
  const entries = skills.map((skill) => lock?.resources?.[skillKey(skill)]).filter(Boolean) as LockEntry[];
  return entries.map((entry) => ({ type: "custom", skill_id: entry.id, version: entry.version }));
}
