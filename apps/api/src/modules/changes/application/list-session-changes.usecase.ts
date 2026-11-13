import type {
  FileDiffMode,
  SessionChangesResponse,
  SessionFileChange,
} from "@contracts/changes";
import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import { isoNow, systemClock, type Clock } from "@core/time";
import { toSessionFileChange } from "../domain/change-record.entity.ts";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";
import { ChangeNotFoundError } from "../domain/errors.ts";
import type { GitWorkspacePort, SessionLookupPort } from "./ports.ts";

export class ListSessionChangesUsecase {
  constructor(
    private readonly sessions: SessionLookupPort,
    private readonly repo: ChangesRepository,
    private readonly git: GitWorkspacePort,
    private readonly defaultCwd: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: {
    sessionId: string;
    mode?: FileDiffMode;
  }): Promise<Result<SessionChangesResponse, AppError>> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) return err(new ChangeNotFoundError(`Session not found: ${input.sessionId}`));

    const mode: FileDiffMode = input.mode === "git" ? "git" : "session";
    const cwd = session.cwd || this.defaultCwd;

    if (mode === "git") {
      return ok(await this.listWorkspaceGitChanges(cwd, session.id));
    }

    const records = this.repo
      .listBySession(session.id)
      .sort((a, b) => (a.lastUpdatedAt < b.lastUpdatedAt ? 1 : -1));
    const files = records.map(toSessionFileChange);
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return ok({
      mode: "session",
      files,
      summary: {
        filesCount: files.length,
        totalAdditions,
        totalDeletions,
      },
    });
  }

  async listWorkspaceGitChanges(cwdInput?: string, sessionId?: string): Promise<SessionChangesResponse> {
    const cwd = cwdInput?.trim() || this.defaultCwd;
    const trackedByPath = sessionId
      ? new Map(this.repo.listBySession(sessionId).map((r) => [r.path, r]))
      : new Map();
    const gitFiles = await this.git.listChanges(cwd);
    const now = isoNow(this.clock);

    const files: SessionFileChange[] = gitFiles.map((gf) => {
      const tracked = trackedByPath.get(gf.path);
      return {
        path: gf.path,
        status: gf.status,
        additions: gf.additions,
        deletions: gf.deletions,
        source: "git_workspace",
        lastUpdatedAt: tracked?.lastUpdatedAt ?? now,
        lastEditedBy: tracked?.lastEditedBy ?? {
          harnessId: "git",
          model: "workspace",
        },
        contributors: tracked?.contributors ?? [{ harnessId: "git", model: "workspace" }],
        revisions: tracked ? toSessionFileChange(tracked).revisions : [],
      };
    });

    return {
      mode: "git",
      files,
      summary: {
        filesCount: files.length,
        totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
        totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
      },
    };
  }
}
