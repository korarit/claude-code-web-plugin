import type { ChatStreamEvent, ModelId } from "@contracts/chat";
import { safeJsonParse } from "@core/utils";

export interface SendOptions {
  prompt: string;
  sessionId?: string;
  model: ModelId;
  signal?: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

/** POST /api/chat/send and invoke onEvent for each SSE event until the stream closes. */
export async function sendChat(options: SendOptions): Promise<void> {
  const res = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: options.prompt,
      sessionId: options.sessionId,
      model: options.model,
    }),
    signal: options.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pendingEvent = "";

  const dispatch = (rawData: string) => {
    const event = safeJsonParse<ChatStreamEvent>(rawData);
    if (event && typeof event.type === "string") options.onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (line.startsWith("event:")) {
        pendingEvent = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        void pendingEvent;
        dispatch(line.slice("data:".length).trim());
        pendingEvent = "";
      }
    }
  }
}
