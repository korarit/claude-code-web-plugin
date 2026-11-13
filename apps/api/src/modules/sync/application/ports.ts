import type { AuthMode, PendingInteraction, SessionControlMode, SessionOrigin, SessionStatus } from "@contracts/chat";
import type { HarnessId } from "@contracts/harness";
import type { CanonicalSyncSummary } from "@contracts/sync";
import type { CanonicalEvent, CanonicalSession } from "../domain/canonical-session.entity.ts";

export interface CanonicalSyncFileWriterPort {
  writeSyncFile(params: {
    cwd: string;
    canonicalSessionId: string;
    fromSeq: number;
    toSeq: number;
    content: string;
  }): Promise<string>;
}

export interface OpenCodeNativeImporterPort {
  isEnabled(): boolean;
  importSession(params: {
    cwd: string;
    canonicalSession: CanonicalSession;
    events: CanonicalEvent[];
  }): Promise<{ externalSessionId: string } | null>;
}

export interface SyncSessionState {
  id: string;
  title?: string;
  model: string;
  harnessId: HarnessId;
  status: SessionStatus;
  origin: SessionOrigin;
  controlMode: SessionControlMode;
  authMode?: AuthMode;
  externalSessionId?: string;
  discoveredAt?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  agentProfile?: string;
  archivedAt?: string | null;
  lastMessagePreview?: string;
  pendingInteraction?: PendingInteraction | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SyncSessionBridgePort {
  getSession(sessionId: string): SyncSessionState | null;
  applyHarnessSwitch(params: {
    sessionId: string;
    harnessId: HarnessId;
    model: string;
    agentProfile?: string;
    externalSessionId?: string;
    tmuxSession?: string;
    transcriptPath?: string;
    adoptInteractive?: boolean;
  }): SyncSessionState | null;
  updateSyncMetadata?(sessionId: string, summary: CanonicalSyncSummary): void;
}

export interface SyncHarnessGatewayPort {
  isAvailable(harnessId: HarnessId): Promise<boolean>;
  getDefaultModel(harnessId: HarnessId): string;
  readRecentEvents?(
    session: SyncSessionState,
    limit?: number,
  ): Promise<
    Array<{
      id?: string;
      type: string;
      role?: "user" | "assistant";
      text?: string;
      tool?: string;
      toolUseId?: string;
      toolInput?: unknown;
      parentToolUseId?: string | null;
      model?: string;
      message?: string;
      timestamp?: string;
    }>
  >;
}

export interface SyncEventPublisherPort {
  publishChatEvent(
    sessionId: string,
    event: {
      id?: string;
      type: "harness_switched" | "status";
      harnessId?: HarnessId;
      switchedFrom?: HarnessId;
      switchedTo?: HarnessId;
      syncedTurnsRange?: { fromSeq: number; toSeq: number };
      model?: string;
      text?: string;
      canonicalSeq?: number;
      status?: SessionStatus;
      timestamp?: string;
    },
  ): void;
  publishSessionUpsert(session: SyncSessionState): void;
  unwatchPreviousObserver?(sessionId: string): void;
}
