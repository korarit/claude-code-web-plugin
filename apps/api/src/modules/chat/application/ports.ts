import type { ModelId } from "@contracts/chat";
import type { DomainChatEvent } from "../domain/chat.events.ts";

export interface RunOptions {
  sessionId?: string;
  model: ModelId;
  cwd?: string;
}

export interface RunnerPort {
  runStream(prompt: string, options: RunOptions): AsyncIterable<DomainChatEvent>;
}
