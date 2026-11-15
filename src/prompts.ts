import { createInterface, emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream } from "node:tty";

// Where the questions are read from: a terminal (process.stdin) or any stream of lines.
export type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

export interface PromptsOptions {
  // The error a cancelled question rejects with.
  cancelled?: () => Error;
}

export interface TextOptions {
  // Returns an error message to ask again, or nothing when the reply is fine.
  validate?: (reply: string) => string | null | undefined | void;
}

// The questions `prompts()` returns, which cred-menu, tools-menu and init take as `io`.
export interface Prompts {
  text(question: string, fallback?: string, options?: TextOptions): Promise<string>;
  select(question: string, choices: readonly string[], fallback: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  secret(question: string): Promise<string>;
  close(): void;
  // Whether piped input has run out (only for piped input).
  ended?(): boolean;
}

// What each kind of input provides; `prompts()` adds validation and confirm on top.
interface BasePrompts {
  text(question: string, fallback: string): Promise<string>;
  select(question: string, choices: readonly string[], fallback: string): Promise<string>;
  secret(question: string): Promise<string>;
  close(): void;
  ended?(): boolean;
}

// Interactive questions, shared by `init` and `cred create`. In a terminal, choices are picked
// with the arrow keys and secrets aren't echoed; with piped input, each answer is a line.
//
//   text(question, fallback, { validate })   an empty reply keeps the fallback; validate returns
//                                            an error message, or nothing when the reply is fine
//   select(question, choices, fallback)      one of `choices` (strings)
//   confirm(question, fallback)              true or false
//   secret(question)                         a reply that isn't shown
//   close()
//
// Ctrl+C rejects with the error `cancelled()` returns.
export function prompts(input: PromptInput, output: NodeJS.WritableStream, { cancelled = () => new Error("cancelled") }: PromptsOptions = {}): Prompts {
  // isTTY is only true on a tty.ReadStream, which has setRawMode.
  const base = input.isTTY ? terminalPrompts(input as ReadStream, output, cancelled) : linePrompts(input, output, cancelled);

  const text = async (question: string, fallback = "", { validate }: TextOptions = {}): Promise<string> => {
    while (true) {
      const reply = await base.text(question, fallback);
      const problem = validate?.(reply);
      if (!problem) return reply;
      output.write(`${problem}\n`);
      if (base.ended?.()) throw cancelled();
    }
  };
  const confirm = async (question: string, fallback?: boolean): Promise<boolean> => {
    while (true) {
      const reply = (await base.text(`${question} [y/n]`, fallback ? "y" : "n")).toLowerCase();
      if (/^(y|yes)$/.test(reply)) return true;
      if (/^(n|no)$/.test(reply)) return false;
      output.write("Answer y or n\n");
    }
  };
  return { ...base, text, confirm };
}

// Prompts for piped input: one answer per line, and choices picked by name or number.
function linePrompts(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, cancelled: () => Error): BasePrompts {
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let ended = false;

  const line = async (): Promise<string | null> => {
    if (ended) return null;
    const { value, done } = await lines.next();
    if (done) {
      ended = true;
      output.write("\n");
      return null;
    }
    return value.trim();
  };
  const text = async (question: string, fallback: string): Promise<string> => {
    output.write(fallback ? `${question} (${fallback}) ` : `${question} `);
    return (await line()) || fallback;
  };
  const select = async (question: string, choices: readonly string[], fallback: string): Promise<string> => {
    const listed = choices.map((c, i) => `${i + 1}) ${c}`).join("  ");
    while (true) {
      const reply = await text(`${question} ${listed}`, String(choices.indexOf(fallback) + 1 || 1));
      const picked = choices[Number(reply) - 1] ?? choices.find((c) => c === reply);
      if (picked) return picked;
      output.write(`Pick one of: ${choices.join(", ")}\n`);
      if (ended) throw cancelled();
    }
  };
  const secret = async (question: string): Promise<string> => {
    output.write(`${question} `);
    const reply = await line();
    if (reply === null) throw cancelled();
    return reply;
  };
  return { text, select, secret, ended: () => ended, close: () => rl.close() };
}

const ESC = "\x1b[";
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;

// Prompts for a terminal: choices are picked with the arrow keys and Enter.
function terminalPrompts(input: ReadStream, output: NodeJS.WritableStream, cancelled: () => Error): BasePrompts {
  // A fresh readline per question, so it doesn't fight the raw-mode select for the arrow keys.
  const text = (question: string, fallback: string) =>
    new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true });
      rl.on("SIGINT", () => {
        rl.close();
        output.write("\n");
        reject(cancelled());
      });
      rl.question(fallback ? `${question} ${dim(`(${fallback})`)} ` : `${question} `, (reply) => {
        rl.close();
        resolve(reply.trim() || fallback);
      });
    });

  const select = (question: string, choices: readonly string[], fallback: string) =>
    new Promise<string>((resolve, reject) => {
      let index = Math.max(0, choices.indexOf(fallback));
      const render = (first: boolean) => {
        if (!first) output.write(`${ESC}${choices.length}A`);
        for (const [i, choice] of choices.entries()) {
          output.write(`${ESC}2K${i === index ? cyan(`❯ ${choice}`) : `  ${choice}`}\n`);
        }
      };
      const finish = (err?: Error) => {
        input.off("keypress", onKey);
        input.setRawMode(false);
        input.pause();
        // Collapse the list to one line with the answer.
        output.write(`${ESC}${choices.length + 1}A${ESC}J${ESC}?25h`);
        output.write(`${question} ${err ? dim("cancelled") : cyan(choices[index])}\n`);
        err ? reject(err) : resolve(choices[index]);
      };
      const onKey = (str: string | undefined, key: Key = {}) => {
        if (key.ctrl && key.name === "c") return finish(cancelled());
        if (key.name === "return" || key.name === "enter") return finish();
        if (key.name === "up" || key.name === "k") index = (index - 1 + choices.length) % choices.length;
        else if (key.name === "down" || key.name === "j" || key.name === "tab") index = (index + 1) % choices.length;
        else if (/^[1-9]$/.test(str ?? "") && Number(str) <= choices.length) index = Number(str) - 1;
        else return;
        render(false);
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write(`${question} ${dim("(↑/↓, Enter)")}\n${ESC}?25l`);
      render(true);
      input.on("keypress", onKey);
    });

  // Not echoed, so the secret doesn't end up on screen or in the scrollback; pasting works.
  const secret = (question: string) =>
    new Promise<string>((resolve, reject) => {
      output.write(`${question} ${dim("(hidden)")} `);
      input.setRawMode(true);
      input.resume();
      let answer = "";
      const finish = (err?: Error) => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
        err ? reject(err) : resolve(answer.trim());
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return finish();
          if (ch === "\u0003") return finish(cancelled());
          if (ch === "\u007f" || ch === "\b") answer = answer.slice(0, -1);
          else if (ch >= " ") answer += ch;
        }
      };
      input.on("data", onData);
    });

  return { text, select, secret, close() {} };
}
