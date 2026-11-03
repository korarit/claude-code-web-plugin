export type DomainChatEventType = "init" | "delta" | "tool" | "task" | "result" | "error";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface DomainChatEvent {
  type: DomainChatEventType;
  text?: string;
  tool?: string;
  parentToolUseId?: string | null;
  usage?: TokenUsage;
  costUsd?: number;
  message?: string;
}
