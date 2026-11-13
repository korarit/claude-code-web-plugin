import type { ListWorktreesResponse } from "@contracts/workspace";
import type { AppError } from "@core/errors";
import { ok, type Result } from "@core/result";
import type { GitWorktreePort } from "./ports.ts";

export class ListWorktreesUsecase {
  constructor(
    private readonly git: GitWorktreePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(cwdInput?: string): Promise<Result<ListWorktreesResponse, AppError>> {
    const cwd = cwdInput?.trim() || this.defaultCwd;
    const repoRoot = await this.git.findRepoRoot(cwd);
    if (!repoRoot) {
      return ok({ repoRoot: null, worktrees: [] });
    }
    const worktrees = await this.git.listWorktrees(repoRoot);
    return ok({ repoRoot, worktrees });
  }
}
