import type { HarnessId } from "@contracts/harness";
import type { SessionControlMode, SessionOrigin } from "@contracts/chat";
import type {
  CanonicalEventDto,
  CanonicalEventKind,
  CanonicalEventRole,
  CanonicalSyncSummary,
  CanonicalToolCall,
  HarnessBindingDto,
  SyncStrategy,
  SyncedTurnsRange,
} from "@contracts/sync";
import { isoNow, type Clock } from "@core/time";

export type HarnessBinding = HarnessBindingDto;

export type CanonicalEvent = CanonicalEventDto & {
  sourceKey?: string;
};

export interface CanonicalSession {
  canonicalSessionId: string;
  activeHarness: HarnessId;
  origin: SessionOrigin;
  controlMode: SessionControlMode;
  cwd?: string;
  title?: string;
  lastSyncStrategy?: SyncStrategy;
  lastSyncFilePath?: string;
  bindings: Partial<Record<HarnessId, HarnessBinding>>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCanonicalSessionParams {
  canonicalSessionId: string;
  activeHarness: HarnessId;
  origin?: SessionOrigin;
  controlMode?: SessionControlMode;
  cwd?: string;
  title?: string;
  initialBinding?: Partial<HarnessBinding>;
}

export function createCanonicalSession(
  params: CreateCanonicalSessionParams,
  clock: Clock,
): CanonicalSession {
  const now = isoNow(clock);
  const binding: HarnessBinding = {
    harnessId: params.activeHarness,
    lastSyncedSeq: 0,
    ...params.initialBinding,
  };
  return {
    canonicalSessionId: params.canonicalSessionId,
    activeHarness: params.activeHarness,
    origin: params.origin ?? "web",
    controlMode: params.controlMode ?? "interactive",
    cwd: params.cwd,
    title: params.title,
    bindings: {
      [params.activeHarness]: binding,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function getOrInitBinding(
  session: CanonicalSession,
  harnessId: HarnessId,
): HarnessBinding {
  return (
    session.bindings[harnessId] ?? {
      harnessId,
      lastSyncedSeq: 0,
    }
  );
}

export function computeUnsyncedDelta(
  events: CanonicalEvent[],
  lastSyncedSeq: number,
): CanonicalEvent[] {
  return events.filter((e) => e.seq > lastSyncedSeq && e.kind !== "harness_switched");
}

export function estimateContextWindow(harnessId: HarnessId, model?: string): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("1m") || m.includes("[1m]") || m.includes("gemini-2.5") || m.includes("gemini-1.5")) {
    return 1_000_000;
  }
  if (m.includes("gpt-4o") || m.includes("o3") || m.includes("o1")) {
    return 128_000;
  }
  if (harnessId === "agy" && !m.includes("claude")) {
    return 1_000_000;
  }
  return 200_000;
}

export function estimateEventBytes(event: CanonicalEvent): number {
  let bytes = 0;
  if (event.text) bytes += Buffer.byteLength(event.text, "utf8");
  if (event.toolOutput) bytes += Buffer.byteLength(event.toolOutput, "utf8");
  if (event.toolInput !== undefined) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(event.toolInput), "utf8");
    } catch {
      bytes += 64;
    }
  }
  if (event.toolCalls) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(event.toolCalls), "utf8");
    } catch {
      bytes += 64;
    }
  }
  return Math.max(bytes, 32);
}

export function estimateDeltaBytes(delta: CanonicalEvent[]): number {
  return delta.reduce((sum, e) => sum + estimateEventBytes(e), 0);
}

export interface SyncThresholds {
  byteThreshold: number;
  turnThreshold: number;
  contextRatioLimit: number;
}

export const DEFAULT_SYNC_THRESHOLDS: SyncThresholds = {
  byteThreshold: 20 * 1024,
  turnThreshold: 40,
  contextRatioLimit: 0.6,
};

export function shouldUseFileSyncFallback(
  delta: CanonicalEvent[],
  targetHarness: HarnessId,
  targetModel?: string,
  thresholds: SyncThresholds = DEFAULT_SYNC_THRESHOLDS,
): boolean {
  if (delta.length === 0) return false;
  if (delta.length > thresholds.turnThreshold) return true;
  const totalBytes = estimateDeltaBytes(delta);
  if (totalBytes > thresholds.byteThreshold) return true;
  const estimatedTokens = Math.ceil(totalBytes / 4);
  const windowTokens = estimateContextWindow(targetHarness, targetModel);
  if (estimatedTokens > windowTokens * thresholds.contextRatioLimit) return true;
  return false;
}

export function buildSyncSummary(
  session: CanonicalSession,
  events: CanonicalEvent[],
  latestSeq: number,
  targetModel?: string,
  thresholds: SyncThresholds = DEFAULT_SYNC_THRESHOLDS,
): CanonicalSyncSummary {
  const activeBinding = getOrInitBinding(session, session.activeHarness);
  const delta = computeUnsyncedDelta(events, activeBinding.lastSyncedSeq);
  const largeContextWarning = shouldUseFileSyncFallback(
    delta,
    session.activeHarness,
    targetModel ?? activeBinding.model,
    thresholds,
  );
  return {
    canonicalSessionId: session.canonicalSessionId,
    activeHarness: session.activeHarness,
    latestSeq,
    pendingSyncCount: delta.length,
    pendingSyncFromSeq: delta[0]?.seq,
    pendingSyncToSeq: delta[delta.length - 1]?.seq,
    lastSyncStrategy: session.lastSyncStrategy,
    lastSyncFilePath: session.lastSyncFilePath,
    largeContextWarning: largeContextWarning || undefined,
    bindings: session.bindings,
  };
}

export interface AppendCanonicalEventInput {
  canonicalSessionId: string;
  id: string;
  sourceKey?: string;
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
