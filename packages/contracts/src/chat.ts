import type { AgentNode, TeamTaskItem } from "./agents.ts";
import type { SessionFileChange } from "./changes.ts";
import type { HarnessId } from "./harness.ts";
import type { CanonicalSyncSummary, SyncStrategy, SyncedTurnsRange } from "./sync.ts";

export type { HarnessId } from "./harness.ts";

export type ModelId = string;

export const AVAILABLE_MODELS: readonly string[] = ["sonnet", "opus", "haiku"];

export type SessionStatus = "idle" | "running" | "waiting_permission" | "stopped";

export type SessionOrigin = "web" | "cli" | "tmux" | "ide" | "opencode_server";

export type SessionControlMode = "interactive" | "mirror";

export type AuthMode = "machine_default" | "api_key";

export type PermissionDecision = "allow_once" | "always_allow" | "deny";

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionItem {
  id: string;
  header?: string;
  prompt: string;
  multiSelect: boolean;
  options: InteractionOption[];
  allowCustomText?: boolean;
}

export type PendingInteraction =
  | {
      id: string;
      sessionId: string;
      kind: "permission";
      toolName: string;
      commandOrTarget?: string;
      message?: string;
      options: { id: PermissionDecision; label: string }[];
      createdAt: string;
    }
  | {
      id: string;
      sessionId: string;
      kind: "question";
      toolUseId?: string;
      questions: QuestionItem[];
      createdAt: string;
    };

export interface ChatSendRequest {
  prompt: string;
  sessionId?: string;
  harnessId?: HarnessId;
  model?: ModelId;
  cwd?: string;
  authMode?: AuthMode;
  agentProfile?: string;
}

export interface ResumeSessionRequest {
  model?: ModelId;
  authMode?: AuthMode;
  agentProfile?: string;
}

export type ChatInputType = "decision" | "selection" | "text" | "key";

export interface ChatInputRequest {
  sessionId: string;
  interactionId?: string;
  inputType: ChatInputType;
  value: string | string[] | Record<string, string | string[]>;
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
  authMode?: AuthMode;
  agentProfile?: string;
  externalSessionId?: string;
  discoveredAt?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  archivedAt?: string | null;
  lastMessagePreview?: string;
  pendingInteraction?: PendingInteraction | null;
  syncSummary?: CanonicalSyncSummary;
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
  | "permission_prompt"
  | "interaction"
  | "interaction_resolved"
  | "file_changed"
  | "agent_updated"
  | "tasks_updated"
  | "harness_switched";

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
}

export type SessionsListEventType = "snapshot" | "upsert" | "delete" | "agent_updated";

export interface SessionsListEvent {
  type: SessionsListEventType;
  session?: SessionInfo;
  sessionId?: string;
  sessions?: SessionInfo[];
  agent?: AgentNode;
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export interface UploadImageResponse {
  path: string;
  filename: string;
  size: number;
}

export interface ConcurrencyWarning {
  activeCount: number;
  limit: number;
}

export type TerminalServerMessage =
  | {
      type: "screen";
      content: string;
      tmuxSession: string;
      timestamp: string;
    }
  | {
      type: "error";
      message: string;
    };

export type TerminalClientMessage =
  | { type: "key"; key: string }
  | { type: "text"; text: string };
