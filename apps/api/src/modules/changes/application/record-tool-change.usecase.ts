import type { FileChangeStatus, FileEditAttribution } from "@contracts/changes";
import { newRevisionId } from "@core/ids";
import { isoNow, systemClock, type Clock } from "@core/time";
import {
  dedupeAttributions,
  extractToolTargetPath,
  isFileEditTool,
  toSessionFileChange,
  type TrackedFileRecord,
  type TrackedRevisionRecord,
} from "../domain/change-record.entity.ts";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";
import {
  computeLineStats,
  decodePreviewText,
  isBinaryBytes,
  normalizeModelLabel,
} from "../domain/diff.ts";
import type {
  ChangeEventPublisherPort,
  GitWorkspacePort,
  SnapshotStorePort,
  WorkspaceFilePort,
} from "./ports.ts";

export interface PreToolSnapshotInput {
  sessionId: string;
  cwd: string;
  harnessId: string;
  model: string;
  toolName: string;
  toolUseId?: string;
  toolInput?: unknown;
  agentId?: string;
}

export interface PostToolChangeInput extends PreToolSnapshotInput {
  editedAt?: string;
}

interface PendingPreState {
  relPath: string;
  bytes: Uint8Array | null;
  model?: string;
  agentId?: string;
}

interface PendingBaseline {
  bytes: Uint8Array | null;
}

function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function reconstructEditBefore(afterBytes: Uint8Array, toolInput: unknown): Uint8Array | null {
  if (!toolInput || typeof toolInput !== "object" || isBinaryBytes(afterBytes)) return null;
  const obj = toolInput as Record<string, unknown>;
  const oldStr = typeof obj["old_string"] === "string" ? obj["old_string"] : null;
  const newStr = typeof obj["new_string"] === "string" ? obj["new_string"] : null;
  if (oldStr === null || newStr === null) return null;
  const afterText = new TextDecoder("utf-8", { fatal: false }).decode(afterBytes);
  if (!afterText.includes(newStr)) return null;
  const idx = afterText.lastIndexOf(newStr);
  const beforeText = afterText.slice(0, idx) + oldStr + afterText.slice(idx + newStr.length);
  return new TextEncoder().encode(beforeText);
}

export class RecordToolChangeUsecase {
  private readonly pendingPre = new Map<string, PendingPreState>();
  private readonly pendingBaselines = new Map<string, PendingBaseline>();
  private readonly knownToolMetadata = new Map<
    string,
    { model?: string; agentId?: string; toolName?: string; toolInput?: unknown }
  >();

  constructor(
    private readonly repo: ChangesRepository,
    private readonly snapshots: SnapshotStorePort,
    private readonly files: WorkspaceFilePort,
    private readonly git: GitWorkspacePort,
    private readonly publisher: ChangeEventPublisherPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async onPreToolUse(input: PreToolSnapshotInput): Promise<void> {
    if (!isFileEditTool(input.toolName)) return;
    const rawTarget = extractToolTargetPath(input.toolName, input.toolInput);
    if (!rawTarget) return;

    let resolved;
    try {
      resolved = await this.files.resolveSafePath(input.cwd, rawTarget);
    } catch {
      return;
    }

    if (input.toolUseId) {
      this.knownToolMetadata.set(`${input.sessionId}:${input.toolUseId}`, {
        model: input.model,
        agentId: input.agentId,
        toolName: input.toolName,
        toolInput: input.toolInput,
      });
    }

    const currentBytes = await this.files.readFileBytes(resolved.absPath);
    const baselineKey = `${input.sessionId}:${resolved.relPath}`;
    if (!this.repo.get(input.sessionId, resolved.relPath) && !this.pendingBaselines.has(baselineKey)) {
      this.pendingBaselines.set(baselineKey, { bytes: currentBytes });
    }

    const preKey = input.toolUseId
      ? `${input.sessionId}:${input.toolUseId}`
      : `${input.sessionId}:${resolved.relPath}`;
    if (!this.pendingPre.has(preKey)) {
      this.pendingPre.set(preKey, {
        relPath: resolved.relPath,
        bytes: currentBytes,
        model: input.model,
        agentId: input.agentId,
      });
    }
  }

  async onPostToolUse(input: PostToolChangeInput): Promise<void> {
    if (!isFileEditTool(input.toolName)) return;
    const rawTarget = extractToolTargetPath(input.toolName, input.toolInput);
    if (!rawTarget) return;

    let resolved;
    try {
      resolved = await this.files.resolveSafePath(input.cwd, rawTarget);
    } catch {
      return;
    }

    const metaKey = input.toolUseId ? `${input.sessionId}:${input.toolUseId}` : undefined;
    const knownMeta = metaKey ? this.knownToolMetadata.get(metaKey) : undefined;
    const model = normalizeModelLabel(input.model || knownMeta?.model, "sonnet");
    const agentId = input.agentId ?? knownMeta?.agentId;

    const existing = this.repo.get(input.sessionId, resolved.relPath);

    // Deduplicate by toolUseId (hooks + JSONL watcher can both observe the same tool_use).
    if (input.toolUseId && existing) {
      const existingRevIdx = existing.revisions.findIndex((r) => r.toolUseId === input.toolUseId);
      if (existingRevIdx >= 0) {
        const prevRev = existing.revisions[existingRevIdx]!;
        const modelChanged = Boolean(input.model && prevRev.model !== model);
        const agentChanged = Boolean(agentId && prevRev.agentId !== agentId);
        if (modelChanged || agentChanged) {
          const updatedRevs = [...existing.revisions];
          updatedRevs[existingRevIdx] = {
            ...prevRev,
            model: modelChanged ? model : prevRev.model,
            agentId: agentId ?? prevRev.agentId,
          };
          const lastRev = updatedRevs[updatedRevs.length - 1]!;
          const updatedRecord: TrackedFileRecord = {
            ...existing,
            revisions: updatedRevs,
            lastEditedBy: {
              harnessId: lastRev.harnessId,
              model: lastRev.model,
              agentId: lastRev.agentId,
            },
            contributors: dedupeAttributions(
              updatedRevs.map((r) => ({
                harnessId: r.harnessId,
                model: r.model,
                agentId: r.agentId,
              })),
            ),
          };
          this.repo.save(input.sessionId, updatedRecord);
          this.publisher.publishFileChanged(
            input.sessionId,
            toSessionFileChange(updatedRecord),
            input.editedAt ?? isoNow(this.clock),
          );
        }
        return;
      }
    }

    const afterBytes = await this.files.readFileBytes(resolved.absPath);
    const preKey = input.toolUseId
      ? `${input.sessionId}:${input.toolUseId}`
      : `${input.sessionId}:${resolved.relPath}`;
    const pendingPre = this.pendingPre.get(preKey);
    if (pendingPre) this.pendingPre.delete(preKey);

    const baselineCacheKey = `${input.sessionId}:${resolved.relPath}`;
    const pendingBaseline = this.pendingBaselines.get(baselineCacheKey);
    if (pendingBaseline) this.pendingBaselines.delete(baselineCacheKey);

    // Determine pre-edit bytes for this revision.
    let preBytes: Uint8Array | null | undefined = pendingPre?.bytes;
    if (preBytes === undefined && existing) {
      preBytes = existing.latestMissing
        ? null
        : existing.latestSnapshotKey
          ? await this.snapshots.loadSnapshot(input.sessionId, existing.latestSnapshotKey)
          : null;
    }
    if ((preBytes === undefined || bytesEqual(preBytes, afterBytes)) && afterBytes !== null) {
      const reconstructed = reconstructEditBefore(afterBytes, input.toolInput);
      if (reconstructed) {
        preBytes = reconstructed;
      }
    }
    if (preBytes === undefined) {
      preBytes = await this.git.readHeadFile(input.cwd, resolved.relPath).catch(() => null);
    }

    // Determine baseline bytes for cumulative session diff.
    let baselineKey = existing?.baselineKey;
    let baselineMissing = existing?.baselineMissing;
    let baselineBytes: Uint8Array | null = null;

    if (existing) {
      baselineBytes = existing.baselineMissing
        ? null
        : existing.baselineKey
          ? await this.snapshots.loadSnapshot(input.sessionId, existing.baselineKey)
          : null;
    } else {
      const rawBaseline = pendingBaseline ? pendingBaseline.bytes : (preBytes ?? null);
      baselineBytes =
        bytesEqual(rawBaseline, afterBytes) && preBytes && !bytesEqual(preBytes, afterBytes)
          ? preBytes
          : rawBaseline;
      if (baselineBytes === null) {
        baselineMissing = true;
      } else {
        baselineKey = `baseline-${newRevisionId()}`;
        await this.snapshots.saveSnapshot(input.sessionId, baselineKey, baselineBytes);
        baselineMissing = false;
      }
    }

    const revId = newRevisionId();
    const seq = (existing?.revisions.length ?? 0) + 1;
    const editedAt = input.editedAt ?? isoNow(this.clock);

    let beforeKey: string | undefined;
    let beforeMissing = true;
    if (preBytes !== null && preBytes !== undefined) {
      beforeKey = `rev-${revId}-before`;
      beforeMissing = false;
      await this.snapshots.saveSnapshot(input.sessionId, beforeKey, preBytes);
    }

    let afterKey: string | undefined;
    let afterMissing = true;
    if (afterBytes !== null) {
      afterKey = `rev-${revId}-after`;
      afterMissing = false;
      await this.snapshots.saveSnapshot(input.sessionId, afterKey, afterBytes);
    }

    const preDecoded = decodePreviewText(preBytes ?? null);
    const afterDecoded = decodePreviewText(afterBytes);
    const revStats =
      preDecoded.isBinary || afterDecoded.isBinary
        ? { additions: 0, deletions: 0 }
        : computeLineStats(preDecoded.text, afterDecoded.text);

    const baseDecoded = decodePreviewText(baselineBytes);
    const cumulativeStats =
      baseDecoded.isBinary || afterDecoded.isBinary
        ? { additions: 0, deletions: 0 }
        : computeLineStats(baseDecoded.text, afterDecoded.text);

    let status: FileChangeStatus = "modified";
    if (baselineMissing && afterBytes !== null) status = "added";
    else if (!baselineMissing && afterBytes === null) status = "deleted";

    const attribution: FileEditAttribution = {
      harnessId: input.harnessId,
      model,
      agentId,
    };

    const revision: TrackedRevisionRecord = {
      revId,
      seq,
      harnessId: input.harnessId,
      model,
      agentId,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      additions: revStats.additions,
      deletions: revStats.deletions,
      editedAt,
      beforeKey,
      beforeMissing,
      afterKey,
      afterMissing,
    };

    const nextRevisions = [...(existing?.revisions ?? []), revision];
    const nextRecord: TrackedFileRecord = {
      path: resolved.relPath,
      status,
      additions: cumulativeStats.additions,
      deletions: cumulativeStats.deletions,
      source: "session_tool",
      lastUpdatedAt: editedAt,
      lastEditedBy: attribution,
      contributors: dedupeAttributions([...(existing?.contributors ?? []), attribution]),
      revisions: nextRevisions,
      baselineKey,
      baselineMissing,
      latestSnapshotKey: afterKey,
      latestMissing: afterMissing,
    };

    this.repo.save(input.sessionId, nextRecord);
    this.publisher.publishFileChanged(
      input.sessionId,
      toSessionFileChange(nextRecord),
      editedAt,
    );
  }
}
