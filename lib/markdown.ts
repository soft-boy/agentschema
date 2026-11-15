import { type Document, parseDocument } from "yaml";

// A file's YAML frontmatter. It is whatever the file says until check has validated it, so its
// values are typed loosely.
export type Frontmatter = Record<string, any>;

// A parsed Markdown file: its frontmatter, its body (trimmed), and the text it was parsed from.
export interface MarkdownFile {
  data: Frontmatter;
  body: string;
  raw: string;
}

export class FileError extends Error {}

// Splits a Markdown file into YAML frontmatter (between `---` fences) and body.
export function parseMarkdown(text: string, file: string): MarkdownFile {
  const normalized = normalize(text);
  if (!normalized.startsWith("---\n")) {
    throw new FileError(`${file}: must start with YAML frontmatter between --- lines`);
  }
  const closing = /^---[ \t]*$/m.exec(normalized.slice(4));
  if (!closing) throw new FileError(`${file}: frontmatter is not closed with a --- line`);
  const end = 4 + closing.index;
  const afterFence = normalized.slice(end + closing[0].length);

  const doc = parseDocument(normalized.slice(4, end));
  if (doc.errors.length > 0) {
    // The YAML library counts lines from the start of the frontmatter; +1 for the opening fence.
    const err = doc.errors[0];
    const line = err.linePos?.[0]?.line;
    const where = line ? `:${line + 1}` : "";
    throw new FileError(`${file}${where}: invalid YAML: ${err.message.split("\n")[0]}`);
  }

  const data = doc.toJS() ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FileError(`${file}: frontmatter must be a YAML mapping (key: value pairs)`);
  }
  return { data, body: afterFence.trim(), raw: text };
}

// Edits a file's frontmatter through `edit(doc)`, keeping its comments and the rest of the file.
// Returns the new text.
export function editFrontmatter(text: string, edit: (doc: Document) => void): string {
  const normalized = normalize(text);
  const end = 4 + /^---[ \t]*$/m.exec(normalized.slice(4))!.index;
  const doc = parseDocument(normalized.slice(4, end));
  edit(doc);
  return `---\n${doc.toString({ lineWidth: 0 })}${normalized.slice(end)}`;
}

const normalize = (text: string): string => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
