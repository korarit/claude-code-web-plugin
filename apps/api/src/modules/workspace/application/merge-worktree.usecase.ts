import { resolve } from "node:path";
import type { MergeWorktreeResponse } from "@contracts/workspace";
import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import { WorkspaceBadRequestError, WorktreeNotFoundError } from "../domain/errors.ts";
import type { GitWorktreePort } from "./ports.ts";

export interface MergeWorktreeInput {
  cwd?: string;
  worktreePath: string;
  targetBranch?: string;
  removeAfterMerge?: boolean;
}

export class MergeWorktreeUsecase {
  constructor(
    private readonly git: GitWorktreePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: MergeWorktreeInput): Promise<Result<MergeWorktreeResponse, AppError>> {
    const cwd = input.cwd?.trim() || this.defaultCwd;
    const repoRoot = await this.git.findRepoRoot(cwd);
    if (!repoRoot) {
      return err(new WorkspaceBadRequestError("Directory is not inside a git repository."));
    }

    const targetPath = resolve(input.worktreePath.trim());
    const worktrees = await this.git.listWorktrees(repoRoot);
    const sourceWt = worktrees.find((w) => resolve(w.path) === targetPath);
    if (!sourceWt) {
      return err(new WorktreeNotFoundError(targetPath));
    }
    if (sourceWt.isMain || !sourceWt.branch) {
      return err(
        new WorkspaceBadRequestError("Source worktree must be a non-main branch worktree."),
      );
    }

    const cleanSource = await this.git.isWorkingTreeClean(sourceWt.path);
    if (!cleanSource) {
      return err(
        new WorkspaceBadRequestError(
          `Worktree "${sourceWt.branch}" has uncommitted changes. Commit or revert them before merging.`,
        ),
      );
    }

    const mainWt = worktrees.find((w) => w.isMain) ?? { path: repoRoot, branch: null };
    const cleanMain = await this.git.isWorkingTreeClean(mainWt.path);
    if (!cleanMain) {
      return err(
        new WorkspaceBadRequestError(
          "Main repository worktree has uncommitted changes. Commit or stash them before merging.",
        ),
      );
    }

    const currentMainBranch = await this.git.getCurrentBranch(mainWt.path);
    const targetBranch = input.targetBranch?.trim() || currentMainBranch || mainWt.branch || "main";

    if (currentMainBranch && targetBranch !== currentMainBranch) {
      return err(
        new WorkspaceBadRequestError(
          `Main worktree is currently on "${currentMainBranch}", not "${targetBranch}".`,
        ),
      );
    }

    const message = await this.git.mergeBranch(mainWt.path, sourceWt.branch);

    let worktreeRemoved = false;
    if (input.removeAfterMerge) {
      await this.git.removeWorktree(repoRoot, sourceWt.path, false);
      await this.git.deleteBranch(repoRoot, sourceWt.branch, false).catch(() => {});
      worktreeRemoved = true;
    }

    return ok({
      merged: true,
      targetBranch,
      sourceBranch: sourceWt.branch,
      worktreeRemoved,
      message,
    });
  }
}
