import { resolve } from "node:path";
import { checkFiles } from "../lib/check.js";
import { folderProblem, readFolder } from "./folder.js";

// Validates an agent folder without calling the API. See checkFiles for what it returns.
export function check(dir, options) {
  const problem = folderProblem(dir);
  if (problem) return { errors: [problem], warnings: [], instance: null };

  const result = checkFiles(readFolder(dir), options);
  // Where each tool's code lives, so its require() calls can resolve from there.
  for (const tool of result.instance?.tools ?? []) tool.path = resolve(dir, tool.file);
  return result;
}
