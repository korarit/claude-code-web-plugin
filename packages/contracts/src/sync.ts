import type { SessionInfo } from "./chat.ts";
import type { HarnessId } from "./harness.ts";

export type SyncStrategy = "direct_verbatim" | "file_sync" | "opencode_import";

export type CanonicalEventRole = "user" | "assistant" | "system";

export type CanonicalEventKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "error"
  | "harness_switched";

export interface CanonicalToolCall {
  id?: string;
  name: string;
  input?: unknown;
}

export interface SyncedTurnsRange {
  fromSeq: number;
  toSeq: number;
}

export interface CanonicalEventDto {
  seq: number;
  id: string;
  canonicalSessionId: string;
  harnessId: HarnessId;
  model?: string;
  role: CanonicalEventRole;
  kind: CanonicalEventKind;
  text?: string;
  toolCalls?: CanonicalToolCall[];
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolOutput?: string;
  filesTouched?: string[];
  switchedFrom?: HarnessId;
  switchedTo?: HarnessId;
  syncedTurnsRange?: SyncedTurnsRange;
  syncStrategy?: SyncStrategy;
  ts: string;
}

export interface HarnessBindingDto {
  harnessId: HarnessId;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  serverUrl?: string;
  model?: string;
  lastSyncedSeq: number;
  lastSyncedAt?: string;
  syncFilePath?: string;
}

export interface CanonicalSyncSummary {
  canonicalSessionId: string;
  activeHarness: HarnessId;
  latestSeq: number;
  pendingSyncCount: number;
  pendingSyncFromSeq?: number;
  pendingSyncToSeq?: number;
  lastSyncStrategy?: SyncStrategy;
  lastSyncFilePath?: string;
  largeContextWarning?: boolean;
  bindings: Partial<Record<HarnessId, HarnessBindingDto>>;
}

export interface SwitchHarnessRequest {
  harnessId: HarnessId;
  model?: string;
  agentProfile?: string;
}

export interface SwitchHarnessResponse {
  session: SessionInfo;
  sync: CanonicalSyncSummary;
  switchEvent: CanonicalEventDto;
}

export interface CanonicalSessionResponse {
  sync: CanonicalSyncSummary;
  events: CanonicalEventDto[];
}
