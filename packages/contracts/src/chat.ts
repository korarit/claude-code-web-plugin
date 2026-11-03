export type ModelId = "sonnet" | "opus" | "haiku";

export const AVAILABLE_MODELS: readonly ModelId[] = ["sonnet", "opus", "haiku"];

export interface ChatSendRequest {
  prompt: string;
  sessionId?: string;
  model?: ModelId;
}

export interface SessionInfo {
  id: string;
  model: ModelId;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ChatEventType = "init" | "delta" | "tool" | "task" | "result" | "error";

export interface ChatStreamEvent {
  type: ChatEventType;
  sessionId: string;
  /** incremental assistant text (delta) */
  text?: string;
  /** tool name e.g. Task, TodoWrite, Bash, Edit */
  tool?: string;
  /** Task/sub-agent label derived from parent_tool_use_id */
  parentToolUseId?: string | null;
  /** token usage reported by CLI result event */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextWindow?: number;
  };
  /** total cost usd reported by CLI */
  costUsd?: number;
  message?: string;
}
