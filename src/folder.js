import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS_DIR } from "../lib/channels.js";
import { editFrontmatter } from "../lib/markdown.js";
import { AGENT_FILE, ENV_FILE } from "../lib/instance.js";
import { SCHEDULED_DIR } from "../lib/scheduled.js";
import { SKILLS_DIR } from "../lib/skills.js";
import { TOOLS_DIR } from "../lib/tools.js";
import { VAULTS_DIR } from "../lib/vaults.js";

const FOLDERS = [TOOLS_DIR, SKILLS_DIR, VAULTS_DIR, CHANNELS_DIR, SCHEDULED_DIR];
const TOP_LEVEL_FILES = [AGENT_FILE, ENV_FILE];

// Why `dir` can't be read as an agent folder, or null when it can.
export function folderProblem(dir) {
  try {
    return statSync(dir).isDirectory() ? null : `${dir}: not a directory`;
  } catch {
    return `${dir}: no such directory`;
  }
}

// Reads an agent folder into a file map (see lib/files.js), as bytes. Only the agent's own files
// are read, so empty folders, hidden files and node_modules aren't part of it.
export function readFolder(dir) {
  const files = {};
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
function walk(folder, prefix, files, followLinks) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(folder, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path, rel, files, followLinks);
    else if (entry.isFile() || (followLinks && entry.isSymbolicLink() && statSync(path).isFile())) files[rel] = readFileSync(path);
  }
}

// Edits a file's frontmatter on disk, keeping its comments and the rest of the file.
export function updateFrontmatter(file, edit) {
  writeFileSync(file, editFrontmatter(readFileSync(file, "utf8"), edit));
}
