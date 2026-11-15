import { type FileMap, pathsUnder, textOf } from "./files.ts";
import type { MarkdownFile } from "./markdown.ts";

// A long system prompt can be split into files in system_prompt/, which go after agent.md's body. Every
// file in the folder counts, at any depth, in the order `tree` lists them, so the folder reads top to
// bottom the way the prompt does: each folder's entries sorted by name, character by character, with a
// folder's files right where the folder sorts. Each file is taken as written, with no frontmatter.
export const SYSTEM_PROMPT_DIR = "system_prompt";

// Text that came from something other than a text file: decoding bytes that aren't UTF-8 leaves
// replacement characters, and binary files have NULs.
const isBinary = (text: string): boolean => text.includes("\uFFFD") || text.includes("\u0000");

// A file in system_prompt/, and its text.
export interface SystemPromptPart {
  file: string;
  text: string;
}

export interface ReadSystemPromptResult {
  parts: SystemPromptPart[];
  errors: string[];
}

// Reads system_prompt/. Returns { parts, errors }, where each part is { file, text } in tree order.
// No system_prompt/ folder means no parts.
export function readSystemPrompt(files: FileMap): ReadSystemPromptResult {
  if (SYSTEM_PROMPT_DIR in files) return { parts: [], errors: [`${SYSTEM_PROMPT_DIR}: not a directory`] };
  const parts: SystemPromptPart[] = [];
  const errors: string[] = [];
  // pathsUnder already lists them in tree's order.
  for (const file of pathsUnder(files, SYSTEM_PROMPT_DIR)) {
    const text = textOf(files[file]);
    if (isBinary(text)) errors.push(`${file}: isn't a text file, so it can't be part of the system prompt`);
    else parts.push({ file, text });
  }
  return { parts, errors };
}

// The whole system prompt: agent.md's body, then each file in system_prompt/, with a blank line between
// them. Empty files add nothing.
export function systemPromptOf({ agent, systemPrompt = [] }: { agent?: Pick<MarkdownFile, "body"> | null; systemPrompt?: SystemPromptPart[] }): string {
  return [agent?.body ?? "", ...systemPrompt.map((part) => part.text.trim())].filter(Boolean).join("\n\n");
}
