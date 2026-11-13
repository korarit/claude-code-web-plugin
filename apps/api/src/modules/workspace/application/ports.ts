import type { WorktreeRecord } from "../domain/worktree.entity.ts";

export interface GitWorktreePort {
  findRepoRoot(cwd: string): Promise<string | null>;
  listWorktrees(repoRoot: string): Promise<WorktreeRecord[]>;
  getCurrentBranch(cwd: string): Promise<string | null>;
  isWorkingTreeClean(cwd: string): Promise<boolean>;
  addWorktree(
    repoRoot: string,
    worktreePath: string,
    branch: string,
    baseBranch?: string,
  ): Promise<void>;
  removeWorktree(repoRoot: string, worktreePath: string, force?: boolean): Promise<void>;
  deleteBranch(repoRoot: string, branch: string, force?: boolean): Promise<void>;
  mergeBranch(mainWorktreePath: string, sourceBranch: string): Promise<string>;
}
