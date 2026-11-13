import type {
  AgentNode,
  CanonicalSyncSummary,
  HarnessId,
  PendingInteraction,
  PermissionPromptPayload,
  SessionFileChange,
  SessionStatus,
  SyncStrategy,
  SyncedTurnsRange,
  TeamTaskItem,
} from "@contracts/index";
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
  | "interaction_resolved"
  | "file_changed"
  | "agent_updated"
  | "tasks_updated"
  | "harness_switched";

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
  fileChange?: SessionFileChange;
  agent?: AgentNode;
  agents?: AgentNode[];
  tasks?: TeamTaskItem[];
  agentId?: string;
  model?: string;
  harnessId?: HarnessId;
  switchedFrom?: HarnessId;
  switchedTo?: HarnessId;
  syncedTurnsRange?: SyncedTurnsRange;
  syncStrategy?: SyncStrategy;
  syncFilePath?: string;
  canonicalSeq?: number;
  message?: string;
  timestamp?: string;
  discoveredExternalSessionId?: string;
  discoveredTranscriptPath?: string;
}

export interface DomainHookEvent {
  sessionId?: string;
  harnessId?: HarnessId;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  hookEventName: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  teammateName?: string;
  taskId?: string;
  taskSubject?: string;
  taskStatus?: string;
  message?: string;
  waitForDecision?: boolean;
}

export interface SessionListEvent {
  type: "upsert" | "delete" | "agent_updated";
  session?: Session;
  syncSummary?: CanonicalSyncSummary;
  sessionId?: string;
  agent?: AgentNode;
}
