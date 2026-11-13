export interface GitWorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  isBare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

export interface ListWorktreesResponse {
  repoRoot: string | null;
  worktrees: GitWorktreeInfo[];
}

export interface CreateWorktreeRequest {
  cwd?: string;
  branch: string;
  baseBranch?: string;
  path?: string;
}

export interface CreateWorktreeResponse {
  repoRoot: string;
  worktree: GitWorktreeInfo;
}

export interface RemoveWorktreeRequest {
  cwd?: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
}

export interface RemoveWorktreeResponse {
  removed: boolean;
  worktreePath: string;
}

export interface MergeWorktreeRequest {
  cwd?: string;
  worktreePath: string;
  targetBranch?: string;
  removeAfterMerge?: boolean;
}

export interface MergeWorktreeResponse {
  merged: boolean;
  targetBranch: string;
  sourceBranch: string;
  worktreeRemoved: boolean;
  message?: string;
}
