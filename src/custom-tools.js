import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { wrapToolCode } from "../lib/tools.js";

// Loads a custom tool's code as a CommonJS module whose module.exports is the function.
// require() resolves relative to the tool's file, so the agent folder's node_modules work.
// The code runs with this process's full access, so only use this on your own machine.
export function loadTool(tool) {
  const module = { exports: {} };
  const fn = runInThisContext(wrapToolCode(tool.code.source), { filename: tool.path });
  fn(module.exports, createRequire(tool.path), module, tool.path, resolve(tool.path, ".."));
  if (typeof module.exports !== "function") {
    throw new Error(`${tool.file}: module.exports must be a function`);
  }
  return module.exports;
}
