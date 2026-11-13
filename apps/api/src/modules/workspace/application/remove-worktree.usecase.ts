import { resolve } from "node:path";
import type { RemoveWorktreeResponse } from "@contracts/workspace";
import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import { WorkspaceBadRequestError, WorktreeNotFoundError } from "../domain/errors.ts";
import type { GitWorktreePort } from "./ports.ts";

export interface RemoveWorktreeInput {
  cwd?: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
}

export class RemoveWorktreeUsecase {
  constructor(
    private readonly git: GitWorktreePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: RemoveWorktreeInput): Promise<Result<RemoveWorktreeResponse, AppError>> {
    const cwd = input.cwd?.trim() || this.defaultCwd;
    const repoRoot = await this.git.findRepoRoot(cwd);
    if (!repoRoot) {
      return err(new WorkspaceBadRequestError("Directory is not inside a git repository."));
    }

    const targetPath = resolve(input.worktreePath.trim());
    const worktrees = await this.git.listWorktrees(repoRoot);
    const match = worktrees.find((w) => resolve(w.path) === targetPath);
    if (!match) {
      return err(new WorktreeNotFoundError(targetPath));
    }
    if (match.isMain) {
      return err(new WorkspaceBadRequestError("Cannot remove the main repository worktree."));
    }

    await this.git.removeWorktree(repoRoot, match.path, Boolean(input.force));

    if (input.deleteBranch && match.branch) {
      await this.git.deleteBranch(repoRoot, match.branch, Boolean(input.force)).catch(() => {});
    }

    return ok({ removed: true, worktreePath: match.path });
  }
}
