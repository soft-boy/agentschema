import { resolve } from "node:path";
import { type CheckOptions, type CheckResult, checkFiles } from "../lib/check.ts";
import { folderProblem, readFolder } from "./folder.ts";

// Validates an agent folder without calling the API. See checkFiles for what it returns.
export function check(dir: string, options?: CheckOptions): CheckResult {
  const problem = folderProblem(dir);
  if (problem) return { errors: [problem], warnings: [], instance: null };

  const result = checkFiles(readFolder(dir), options);
  // Where each tool's code lives, so its require() calls can resolve from there.
  for (const tool of result.instance?.tools ?? []) tool.path = resolve(dir, tool.file);
  return result;
}
