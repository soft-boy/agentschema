import { createInterface } from "node:readline";
import { Conversation } from "./session.js";
import { loadTool } from "./tools.js";

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

// Prints the agent's text as it streams in, chunk by chunk. Deltas are best effort (the server
// may stop sending them under load), so the complete agent.message that follows is the record:
// whatever part of it the deltas didn't cover is printed then.
export function textStream(write) {
  let preview = null; // { id, text } for the agent.message being previewed
  const close = () => {
    if (preview?.text) write("\n");
    preview = null;
  };
  return {
    // Returns true when the event was printed here, so it shouldn't be printed again.
    handle(event) {
      switch (event.type) {
        case "event_start":
          close();
          if (event.event?.type === "agent.message") preview = { id: event.event.id, text: "" };
          return true;
        case "event_delta": {
          const content = event.delta?.content;
          if (preview?.id !== event.event_id || content?.type !== "text" || !content.text) return true;
          preview.text += content.text;
          write(content.text);
          return true;
        }
        case "agent.message": {
          if (preview?.id !== event.id) {
            close();
            return false;
          }
          const full = formatEvent(event);
          const shown = preview.text;
          preview = null;
          if (full.startsWith(shown)) {
            if (full.length > 0) write(`${full.slice(shown.length)}\n`);
          } else {
            write(`\n${full}\n`);
          }
          return true;
        }
        default:
          // A model request that errors or is interrupted ends without its agent.message.
          close();
          return false;
      }
    },
  };
}

// Runs a custom tool's code with the call's input. A thrown error is returned as an error
// result, so the agent sees what went wrong.
export async function runTool(tool, input) {
  try {
    const value = await loadTool(tool)(input);
    return { text: typeof value === "string" ? value : (JSON.stringify(value) ?? "") };
  } catch (err) {
    return { text: `Error: ${err?.message ?? err}`, isError: true };
  }
}

// Runs an interactive chat in the terminal until the user quits or the session ends.
// `tools` maps custom tool names to their tools/ files; their code runs here when called.
export async function chat(client, session, { agentName, tools = {}, input = process.stdin, output = process.stdout }) {
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

  const stream = textStream((text) => output.write(text));
  const ui = {
    event(event) {
      if (stream.handle(event)) return;
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
      if (tools[event.name]) {
        const result = await runTool(tools[event.name], event.input);
        if (result.isError) output.write(`${red(`  ↳ ${truncate(result.text.split("\n")[0])}`)}\n`);
        return result;
      }
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
  if (!ended) output.write(dim(`Resume this conversation with: agentschema run --resume ${session.id}\n`));
}
