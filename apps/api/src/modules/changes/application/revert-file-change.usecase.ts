import type { FileDiffMode, RevertFileResponse } from "@contracts/changes";
import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";
import { ChangeBadRequestError, ChangeNotFoundError } from "../domain/errors.ts";
import type {
  GitWorkspacePort,
  SessionLookupPort,
  SnapshotStorePort,
  WorkspaceFilePort,
} from "./ports.ts";

export class RevertFileChangeUsecase {
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
  }): Promise<Result<RevertFileResponse, AppError>> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) return err(new ChangeNotFoundError(`Session not found: ${input.sessionId}`));

    const rawPath = input.path?.trim();
    if (!rawPath) return err(new ChangeBadRequestError("path is required"));

    const cwd = session.cwd || this.defaultCwd;
    let resolved;
    try {
      resolved = await this.files.resolveSafePath(cwd, rawPath);
    } catch (e) {
      return err(e as AppError);
    }

    const mode: FileDiffMode = input.mode === "git" ? "git" : "session";

    if (mode === "git") {
      await this.git.revertFile(cwd, resolved.relPath);
      this.repo.delete(session.id, resolved.relPath);
      return ok({ reverted: true, path: resolved.relPath, mode: "git" });
    }

    const record = this.repo.get(session.id, resolved.relPath);
    if (!record) {
      return err(new ChangeNotFoundError(`No tracked change for ${resolved.relPath} in session`));
    }

    if (record.baselineMissing) {
      await this.files.removeFile(resolved.absPath);
    } else if (record.baselineKey) {
      const baselineBytes = await this.snapshots.loadSnapshot(session.id, record.baselineKey);
      if (baselineBytes === null) {
        return err(new ChangeNotFoundError(`Baseline snapshot missing for ${resolved.relPath}`));
      }
      await this.files.writeFileBytes(resolved.absPath, baselineBytes);
    }

    this.repo.delete(session.id, resolved.relPath);
    return ok({ reverted: true, path: resolved.relPath, mode: "session" });
  }
}
