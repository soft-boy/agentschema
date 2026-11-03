import { createInterface } from "node:readline";
import { Conversation } from "./session.js";

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = color(2);
const red = color(31);
const bold = color(1);

// Prints a session's events as a terminal transcript.
export function formatEvent(event) {
  switch (event.type) {
    case "agent.message":
      return event.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      const name = event.type === "agent.mcp_tool_use" ? `${event.mcp_server_name}.${event.name}` : event.name;
      const denied = event.evaluated_permission === "deny" ? red(" (denied)") : "";
      return dim(`· ${name} ${summarize(event.input)}`) + denied;
    }
    case "agent.custom_tool_use":
      return dim(`· ${event.name} ${summarize(event.input)}`);
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      if (!event.is_error) return null;
      return red(`  ↳ ${firstLine(event.content)}`);
    case "session.error":
      return red(`error: ${event.error?.message ?? event.error?.type ?? "unknown error"}`);
    case "session.status_idle": {
      const reason = event.stop_reason?.type;
      if (reason === "retries_exhausted") return red("The agent gave up after repeated errors.");
      if (reason === "budget_reached") return red("The session reached its budget and paused.");
      return null;
    }
    case "session.status_terminated":
      return dim("The session has ended.");
    default:
      return null;
  }
}

// One line describing a tool call's input: the command, path or query when there is one.
function summarize(input = {}) {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    if (typeof input[key] === "string") return truncate(input[key]);
  }
  return truncate(JSON.stringify(input));
}

function firstLine(content = []) {
  const text = content.find((b) => b.type === "text")?.text ?? "tool error";
  return truncate(text.split("\n")[0]);
}

const truncate = (s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Runs an interactive chat in the terminal until the user quits or the session ends.
export async function chat(client, session, { agentName, input = process.stdin, output = process.stdout }) {
  const rl = createInterface({ input, output, terminal: input.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  let running = false;
  let interrupted = false;
  let quit = false;

  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    if (done) quit = true;
    return done ? null : value;
  };

  const ui = {
    event(event) {
      const text = formatEvent(event);
      if (text) output.write(`${text}\n`);
    },
    async confirm(event) {
      const answer = await ask(bold(`Allow ${event.name}? `) + dim("[y/N, or type why not] "));
      if (answer && /^(y|yes)$/i.test(answer.trim())) return { result: "allow" };
      const reason = answer?.trim();
      return { result: "deny", deny_message: reason && !/^(n|no)$/i.test(reason) ? reason : undefined };
    },
    async customToolResult(event) {
      output.write(dim(`${event.name} is a custom tool, so you supply its result.\n`));
      output.write(dim(`input: ${JSON.stringify(event.input)}\n`));
      return (await ask(bold("result> "))) ?? "The user didn't provide a result.";
    },
  };

  const conversation = new Conversation(client, session.id, ui);
  let ended = false;

  // Ctrl+C interrupts the agent while it works; a second Ctrl+C, or one at the prompt, quits.
  rl.on("SIGINT", () => {
    if (running && !interrupted) {
      interrupted = true;
      output.write(dim("\nInterrupting… (Ctrl+C again to quit)\n"));
      conversation.interrupt().catch(() => {});
      return;
    }
    quit = true;
    conversation.close();
    rl.close();
  });

  output.write(dim(`${agentName} · session ${session.id}\nCtrl+C interrupts the agent, Ctrl+D quits.\n\n`));

  try {
    while (!quit) {
      const text = await ask(bold("> "));
      if (text === null) break;
      if (text.trim() === "") continue;

      running = true;
      interrupted = false;
      let outcome;
      try {
        outcome = await conversation.send(text);
      } catch (err) {
        if (quit) break;
        throw err;
      } finally {
        running = false;
      }
      output.write("\n");
      if (outcome === "terminated") {
        ended = true;
        break;
      }
    }
  } finally {
    conversation.close();
    rl.close();
  }
  if (!ended) output.write(dim(`Resume this conversation with: agentschema run --session ${session.id}\n`));
}
