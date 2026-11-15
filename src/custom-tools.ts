import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { type Tool, wrapToolCode } from "../lib/tools.ts";

// What a custom tool's code exports: called with the tool's input, it returns (or resolves to) the result.
export type CustomToolFunction = (input: unknown) => unknown;

// Loads a custom tool's code as a CommonJS module whose module.exports is the function.
// require() resolves relative to the tool's file, so the agent folder's node_modules work.
// The code runs with this process's full access, so only use this on your own machine.
// `tool` is a custom tool from check(): its code was checked to be there, and check() set its path.
export function loadTool(tool: Pick<Tool, "file" | "code" | "path">): CustomToolFunction {
  const path = tool.path!;
  const module: { exports: unknown } = { exports: {} };
  const fn = runInThisContext(wrapToolCode(tool.code!.source), { filename: path });
  fn(module.exports, createRequire(path), module, path, resolve(path, ".."));
  if (typeof module.exports !== "function") {
    throw new Error(`${tool.file}: module.exports must be a function`);
  }
  return module.exports as CustomToolFunction;
}
