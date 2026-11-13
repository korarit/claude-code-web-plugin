import type {
  FileChangeStatus,
  FileDiffMode,
  FileDiffResponse,
  FileEditAttribution,
} from "@contracts/changes";
import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";
import { buildUnifiedDiff, decodePreviewText } from "../domain/diff.ts";
import {
  ChangeBadRequestError,
  ChangeNotFoundError,
} from "../domain/errors.ts";
import type {
  GitWorkspacePort,
  SessionLookupPort,
  SnapshotStorePort,
  WorkspaceFilePort,
} from "./ports.ts";

export class GetFileDiffUsecase {
  constructor(
    private readonly sessions: SessionLookupPort,
    private readonly repo: ChangesRepository,
    private readonly snapshots: SnapshotStorePort,
    private readonly files: WorkspaceFilePort,
    private readonly git: GitWorkspacePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: {
    sessionId: string;
    path: string;
    mode?: FileDiffMode;
    revId?: string;
  }): Promise<Result<FileDiffResponse, AppError>> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) return err(new ChangeNotFoundError(`Session not found: ${input.sessionId}`));

    const rawPath = input.path?.trim();
    if (!rawPath) return err(new ChangeBadRequestError("path query parameter is required"));

    const cwd = session.cwd || this.defaultCwd;
    let resolved;
    try {
      resolved = await this.files.resolveSafePath(cwd, rawPath);
    } catch (e) {
      return err(e as AppError);
    }

    const mode: FileDiffMode = input.mode === "git" ? "git" : "session";

    if (mode === "git") {
      return this.getWorkspaceGitDiff(cwd, rawPath);
    }

    const record = this.repo.get(session.id, resolved.relPath);
    if (!record) {
      return err(new ChangeNotFoundError(`No tracked changes for ${resolved.relPath} in session`));
    }

    let originalBytes: Uint8Array | null;
    let modifiedBytes: Uint8Array | null;
    let editedBy: FileEditAttribution | undefined = record.lastEditedBy;
    let status: FileChangeStatus = record.status;

    if (input.revId) {
      const rev = record.revisions.find((r) => r.revId === input.revId);
      if (!rev) {
        return err(new ChangeNotFoundError(`Revision not found: ${input.revId}`));
      }
      editedBy = { harnessId: rev.harnessId, model: rev.model, agentId: rev.agentId };
      originalBytes = rev.beforeMissing
        ? null
        : rev.beforeKey
          ? await this.snapshots.loadSnapshot(session.id, rev.beforeKey)
          : null;
      modifiedBytes = rev.afterMissing
        ? null
        : rev.afterKey
          ? await this.snapshots.loadSnapshot(session.id, rev.afterKey)
          : null;
      status =
        originalBytes === null && modifiedBytes !== null
          ? "added"
          : originalBytes !== null && modifiedBytes === null
            ? "deleted"
            : "modified";
    } else {
      originalBytes = record.baselineMissing
        ? null
        : record.baselineKey
          ? await this.snapshots.loadSnapshot(session.id, record.baselineKey)
          : null;

      const diskBytes = await this.files.readFileBytes(resolved.absPath);
      if (diskBytes !== null) {
        modifiedBytes = diskBytes;
      } else if (!record.latestMissing && record.latestSnapshotKey) {
        modifiedBytes = await this.snapshots.loadSnapshot(session.id, record.latestSnapshotKey);
      } else {
        modifiedBytes = null;
      }
    }

    const orig = decodePreviewText(originalBytes);
    const mod = decodePreviewText(modifiedBytes);
    const isBinary = orig.isBinary || mod.isBinary;
    const truncated = orig.truncated || mod.truncated;

    return ok({
      path: resolved.relPath,
      status,
      mode: "session",
      revId: input.revId,
      editedBy,
      originalText: isBinary ? null : orig.text,
      modifiedText: isBinary ? null : mod.text,
      unifiedDiff: isBinary ? "" : buildUnifiedDiff(resolved.relPath, orig.text, mod.text),
      isBinary,
      truncated,
    });
  }

  async getWorkspaceGitDiff(
    cwdInput: string | undefined,
    rawPath: string,
  ): Promise<Result<FileDiffResponse, AppError>> {
    const trimmedPath = rawPath?.trim();
    if (!trimmedPath) return err(new ChangeBadRequestError("path query parameter is required"));

    const cwd = cwdInput?.trim() || this.defaultCwd;
    let resolved;
    try {
      resolved = await this.files.resolveSafePath(cwd, trimmedPath);
    } catch (e) {
      return err(e as AppError);
    }

    const [headBytes, currentBytes] = await Promise.all([
      this.git.readHeadFile(cwd, resolved.relPath),
      this.files.readFileBytes(resolved.absPath),
    ]);

    if (headBytes === null && currentBytes === null) {
      return err(new ChangeNotFoundError(`File not found in git or workspace: ${resolved.relPath}`));
    }

    const orig = decodePreviewText(headBytes);
    const mod = decodePreviewText(currentBytes);
    const isBinary = orig.isBinary || mod.isBinary;
    const truncated = orig.truncated || mod.truncated;
    const status: FileChangeStatus =
      headBytes === null ? "added" : currentBytes === null ? "deleted" : "modified";

    return ok({
      path: resolved.relPath,
      status,
      mode: "git",
      originalText: isBinary ? null : orig.text,
      modifiedText: isBinary ? null : mod.text,
      unifiedDiff: isBinary ? "" : buildUnifiedDiff(resolved.relPath, orig.text, mod.text),
      isBinary,
      truncated,
    });
  }
}
