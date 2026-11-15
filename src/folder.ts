import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Document } from "yaml";
import { CHANNELS_DIR } from "../lib/channels.ts";
import type { FileMap } from "../lib/files.ts";
import { editFrontmatter } from "../lib/markdown.ts";
import { AGENT_FILE, COMPUTER_FILE, OLD_COMPUTER_FILE } from "../lib/instance.ts";
import { SCHEDULED_DIR } from "../lib/scheduled.ts";
import { SKILLS_DIR } from "../lib/skills.ts";
import { SYSTEM_PROMPT_DIR } from "../lib/system-prompt.ts";
import { TOOLS_DIR } from "../lib/tools.ts";
import { VAULTS_DIR } from "../lib/vaults.ts";

const FOLDERS: string[] = [TOOLS_DIR, SKILLS_DIR, VAULTS_DIR, CHANNELS_DIR, SCHEDULED_DIR, SYSTEM_PROMPT_DIR];
const TOP_LEVEL_FILES: string[] = [AGENT_FILE, COMPUTER_FILE, OLD_COMPUTER_FILE];

// Why `dir` can't be read as an agent folder, or null when it can.
export function folderProblem(dir: string): string | null {
  try {
    return statSync(dir).isDirectory() ? null : `${dir}: not a directory`;
  } catch {
    return `${dir}: no such directory`;
  }
}

// Reads an agent folder into a file map (see lib/files.js), as bytes. Only the agent's own files
// are read, so empty folders, hidden files and node_modules aren't part of it.
export function readFolder(dir: string): FileMap {
  const files: FileMap = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (FOLDERS.includes(entry.name)) {
      if (statSync(path).isDirectory()) walk(path, entry.name, files, entry.name !== SKILLS_DIR);
      else files[entry.name] = readFileSync(path);
    } else if (TOP_LEVEL_FILES.includes(entry.name.toLowerCase()) && !statSync(path).isDirectory()) {
      files[entry.name] = readFileSync(path);
    }
  }
  return files;
}

// Everything in a skill's folder gets uploaded, so links there aren't followed, in case one
// points outside the agent.
function walk(folder: string, prefix: string, files: FileMap, followLinks: boolean): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(folder, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path, rel, files, followLinks);
    else if (entry.isFile() || (followLinks && entry.isSymbolicLink() && statSync(path).isFile())) files[rel] = readFileSync(path);
  }
}

// Edits a file's frontmatter on disk, keeping its comments and the rest of the file.
export function updateFrontmatter(file: string, edit: (doc: Document) => void): void {
  writeFileSync(file, editFrontmatter(readFileSync(file, "utf8"), edit));
}
