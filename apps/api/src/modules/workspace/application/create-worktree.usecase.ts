import { resolve } from "node:path";
import type { CreateWorktreeResponse } from "@contracts/workspace";
import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import {
  WorkspaceBadRequestError,
  WorktreeAlreadyExistsError,
} from "../domain/errors.ts";
import {
  deriveDefaultWorktreePath,
  sanitizeBranchName,
} from "../domain/worktree.entity.ts";
import type { GitWorktreePort } from "./ports.ts";

export interface CreateWorktreeInput {
  cwd?: string;
  branch: string;
  baseBranch?: string;
  path?: string;
}

export class CreateWorktreeUsecase {
  constructor(
    private readonly git: GitWorktreePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: CreateWorktreeInput): Promise<Result<CreateWorktreeResponse, AppError>> {
    const cwd = input.cwd?.trim() || this.defaultCwd;
    const repoRoot = await this.git.findRepoRoot(cwd);
    if (!repoRoot) {
      return err(new WorkspaceBadRequestError("Directory is not inside a git repository."));
    }

    const branch = sanitizeBranchName(input.branch);
    if (!branch) {
      return err(new WorkspaceBadRequestError("A valid branch name is required."));
    }

    if (input.path && input.path.includes("..")) {
      return err(new WorkspaceBadRequestError("Invalid worktree path."));
    }

    const targetPath = input.path?.trim()
      ? resolve(input.path.trim())
      : deriveDefaultWorktreePath(repoRoot, branch);

    const existing = await this.git.listWorktrees(repoRoot);
    if (existing.some((w) => resolve(w.path) === targetPath || w.branch === branch)) {
      return err(new WorktreeAlreadyExistsError(branch));
    }

    await this.git.addWorktree(repoRoot, targetPath, branch, input.baseBranch?.trim() || undefined);

    const updated = await this.git.listWorktrees(repoRoot);
    const created = updated.find((w) => resolve(w.path) === targetPath) ?? {
      path: targetPath,
      branch,
      head: "",
      isMain: false,
    };

    return ok({ repoRoot, worktree: created });
  }
}
