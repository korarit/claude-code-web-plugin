export type ModelId = "sonnet" | "opus" | "haiku";

export const AVAILABLE_MODELS: readonly ModelId[] = ["sonnet", "opus", "haiku"];

export type HarnessId = "claude" | "agy" | "opencode";

export type SessionStatus = "idle" | "running" | "waiting_permission" | "stopped";

export type SessionOrigin = "web" | "cli" | "tmux" | "ide" | "opencode_server";

export type SessionControlMode = "interactive" | "mirror";

export interface ChatSendRequest {
  prompt: string;
  sessionId?: string;
  model?: ModelId;
  cwd?: string;
}

export interface ChatInputRequest {
  input?: string;
  key?: string;
}

export interface SessionUpdateRequest {
  title?: string;
  archived?: boolean;
}

export interface SessionInfo {
  id: string;
  title?: string;
  model: ModelId;
  harnessId: HarnessId;
  status: SessionStatus;
  origin: SessionOrigin;
  controlMode: SessionControlMode;
  externalSessionId?: string;
  discoveredAt?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  archivedAt?: string | null;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ChatEventType =
  | "init"
  | "user"
  | "delta"
  | "tool"
  | "task"
  | "result"
  | "error"
  | "status"
  | "permission_prompt";

export interface PermissionPromptPayload {
  tool?: string;
  command?: string;
  message?: string;
}

export interface ChatStreamEvent {
  id?: string;
  type: ChatEventType;
  sessionId: string;
  role?: "user" | "assistant";
  /** incremental or message text */
  text?: string;
  /** tool name e.g. Task, TodoWrite, Bash, Edit */
  tool?: string;
  toolUseId?: string;
  toolInput?: unknown;
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
  status?: SessionStatus;
  permissionPrompt?: PermissionPromptPayload;
  message?: string;
  timestamp?: string;
}

export type SessionsListEventType = "snapshot" | "upsert" | "delete";

export interface SessionsListEvent {
  type: SessionsListEventType;
  session?: SessionInfo;
  sessionId?: string;
  sessions?: SessionInfo[];
}
