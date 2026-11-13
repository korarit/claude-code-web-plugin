import type {
  PendingInteraction,
  PermissionPromptPayload,
  SessionStatus,
} from "@contracts/chat";
import type { Session } from "./session.entity.ts";

export type DomainChatEventType =
  | "init"
  | "user"
  | "delta"
  | "tool"
  | "task"
  | "result"
  | "error"
  | "status"
  | "permission_prompt"
  | "interaction"
  | "interaction_resolved";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface DomainChatEvent {
  id?: string;
  type: DomainChatEventType;
  role?: "user" | "assistant";
  text?: string;
  tool?: string;
  toolUseId?: string;
  toolInput?: unknown;
  parentToolUseId?: string | null;
  usage?: TokenUsage;
  costUsd?: number;
  status?: SessionStatus;
  permissionPrompt?: PermissionPromptPayload;
  interaction?: PendingInteraction;
  interactionId?: string;
  message?: string;
  timestamp?: string;
}

export interface DomainHookEvent {
  sessionId?: string;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  hookEventName: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  message?: string;
  waitForDecision?: boolean;
}

export interface SessionListEvent {
  type: "upsert" | "delete";
  session?: Session;
  sessionId?: string;
}
