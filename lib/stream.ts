// A block of an event's content. Only text blocks are read here.
export interface ContentBlock {
  type: string;
  text?: string;
}

// A complete agent.message event.
export interface AgentMessageEvent {
  type: "agent.message";
  id: string;
  content: ContentBlock[];
}

// A session event, as far as textStream reads it: event_start's `event` previews the event that's
// starting, event_delta's `delta` adds to it, and agent.message is the complete event.
export interface StreamEvent {
  type: string;
  id?: string;
  event_id?: string;
  event?: { type?: string; id?: string };
  delta?: { content?: { type?: string; text?: string } };
  content?: ContentBlock[];
}

export interface TextStream {
  handle(event: StreamEvent): boolean;
}

// The text of a complete agent.message event.
export const agentMessageText = (event: Pick<AgentMessageEvent, "content">): string => event.content.filter((b) => b.type === "text").map((b) => b.text).join("");

// Passes the agent's text to `write` as it streams in, chunk by chunk. Deltas are best effort (the
// server may stop sending them under load), so the complete agent.message that follows is the
// record: whatever part of it the deltas didn't cover is written then.
export function textStream(write: (text: string) => void): TextStream {
  // The agent.message being previewed. The `!`s below rely on deltas and agent.messages always
  // having their ids, so that matching the preview's id means there is one.
  let preview: { id: string | undefined; text: string } | null = null;
  const close = () => {
    if (preview?.text) write("\n");
    preview = null;
  };
  return {
    // Returns true when the event was written here, so it shouldn't be shown again.
    handle(event: StreamEvent): boolean {
      switch (event.type) {
        case "event_start":
          close();
          if (event.event?.type === "agent.message") preview = { id: event.event.id, text: "" };
          return true;
        case "event_delta": {
          const content = event.delta?.content;
          if (preview?.id !== event.event_id || content?.type !== "text" || !content.text) return true;
          preview!.text += content.text;
          write(content.text);
          return true;
        }
        case "agent.message": {
          if (preview?.id !== event.id) {
            close();
            return false;
          }
          const full = agentMessageText(event as AgentMessageEvent);
          const shown = preview!.text;
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
