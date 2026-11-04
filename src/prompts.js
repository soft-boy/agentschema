import { createInterface, emitKeypressEvents } from "node:readline";

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
export function prompts(input, output, { cancelled = () => new Error("cancelled") } = {}) {
  const base = input.isTTY ? terminalPrompts(input, output, cancelled) : linePrompts(input, output, cancelled);

  const text = async (question, fallback = "", { validate } = {}) => {
    while (true) {
      const reply = await base.text(question, fallback);
      const problem = validate?.(reply);
      if (!problem) return reply;
      output.write(`${problem}\n`);
      if (base.ended?.()) throw cancelled();
    }
  };
  const confirm = async (question, fallback) => {
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
function linePrompts(input, output, cancelled) {
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let ended = false;

  const line = async () => {
    if (ended) return null;
    const { value, done } = await lines.next();
    if (done) {
      ended = true;
      output.write("\n");
      return null;
    }
    return value.trim();
  };
  const text = async (question, fallback) => {
    output.write(fallback ? `${question} (${fallback}) ` : `${question} `);
    return (await line()) || fallback;
  };
  const select = async (question, choices, fallback) => {
    const listed = choices.map((c, i) => `${i + 1}) ${c}`).join("  ");
    while (true) {
      const reply = await text(`${question} ${listed}`, String(choices.indexOf(fallback) + 1 || 1));
      const picked = choices[Number(reply) - 1] ?? choices.find((c) => c === reply);
      if (picked) return picked;
      output.write(`Pick one of: ${choices.join(", ")}\n`);
      if (ended) throw cancelled();
    }
  };
  const secret = async (question) => {
    output.write(`${question} `);
    const reply = await line();
    if (reply === null) throw cancelled();
    return reply;
  };
  return { text, select, secret, ended: () => ended, close: () => rl.close() };
}

const ESC = "\x1b[";
const cyan = (s) => `${ESC}36m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;

// Prompts for a terminal: choices are picked with the arrow keys and Enter.
function terminalPrompts(input, output, cancelled) {
  // A fresh readline per question, so it doesn't fight the raw-mode select for the arrow keys.
  const text = (question, fallback) =>
    new Promise((resolve, reject) => {
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

  const select = (question, choices, fallback) =>
    new Promise((resolve, reject) => {
      let index = Math.max(0, choices.indexOf(fallback));
      const render = (first) => {
        if (!first) output.write(`${ESC}${choices.length}A`);
        for (const [i, choice] of choices.entries()) {
          output.write(`${ESC}2K${i === index ? cyan(`❯ ${choice}`) : `  ${choice}`}\n`);
        }
      };
      const finish = (err) => {
        input.off("keypress", onKey);
        input.setRawMode(false);
        input.pause();
        // Collapse the list to one line with the answer.
        output.write(`${ESC}${choices.length + 1}A${ESC}J${ESC}?25h`);
        output.write(`${question} ${err ? dim("cancelled") : cyan(choices[index])}\n`);
        err ? reject(err) : resolve(choices[index]);
      };
      const onKey = (str, key = {}) => {
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
  const secret = (question) =>
    new Promise((resolve, reject) => {
      output.write(`${question} ${dim("(hidden)")} `);
      input.setRawMode(true);
      input.resume();
      let answer = "";
      const finish = (err) => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        output.write("\n");
        err ? reject(err) : resolve(answer.trim());
      };
      const onData = (chunk) => {
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
