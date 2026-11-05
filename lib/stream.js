// The text of a complete agent.message event.
export const agentMessageText = (event) => event.content.filter((b) => b.type === "text").map((b) => b.text).join("");

// Passes the agent's text to `write` as it streams in, chunk by chunk. Deltas are best effort (the
// server may stop sending them under load), so the complete agent.message that follows is the
// record: whatever part of it the deltas didn't cover is written then.
export function textStream(write) {
  let preview = null; // { id, text } for the agent.message being previewed
  const close = () => {
    if (preview?.text) write("\n");
    preview = null;
  };
  return {
    // Returns true when the event was written here, so it shouldn't be shown again.
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
          const full = agentMessageText(event);
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
