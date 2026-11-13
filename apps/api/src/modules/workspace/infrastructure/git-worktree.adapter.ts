import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WorkspaceGitError } from "../domain/errors.ts";
import { parseGitWorktreePorcelain, type WorktreeRecord } from "../domain/worktree.entity.ts";
import type { GitWorktreePort } from "../application/ports.ts";

async function execGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

export class LocalGitWorktreeAdapter implements GitWorktreePort {
  async findRepoRoot(cwd: string): Promise<string | null> {
    if (!existsSync(cwd)) return null;
    const res = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (!res.ok) return null;
    const root = res.stdout.trim();
    return root || null;
  }

  async listWorktrees(repoRoot: string): Promise<WorktreeRecord[]> {
    const res = await execGit(repoRoot, ["worktree", "list", "--porcelain"]);
    if (!res.ok) {
      throw new WorkspaceGitError(res.stderr.trim() || "Failed to list git worktrees", 500);
    }
    return parseGitWorktreePorcelain(res.stdout);
  }

  async getCurrentBranch(cwd: string): Promise<string | null> {
    const res = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!res.ok) return null;
    const branch = res.stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  }

  async isWorkingTreeClean(cwd: string): Promise<boolean> {
    const res = await execGit(cwd, ["status", "--porcelain"]);
    if (!res.ok) return false;
    return res.stdout.trim().length === 0;
  }

  async addWorktree(
    repoRoot: string,
    worktreePath: string,
    branch: string,
    baseBranch?: string,
  ): Promise<void> {
    mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o755 });
    const branchExists = !baseBranch
      ? (await execGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok
      : false;
    const args = branchExists
      ? ["worktree", "add", worktreePath, branch]
      : ["worktree", "add", worktreePath, "-b", branch, ...(baseBranch ? [baseBranch] : [])];
    const res = await execGit(repoRoot, args);
    if (!res.ok) {
      throw new WorkspaceGitError(res.stderr.trim() || "Failed to create git worktree", 400);
    }
  }

  async removeWorktree(repoRoot: string, worktreePath: string, force = false): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    const res = await execGit(repoRoot, args);
    if (!res.ok) {
      throw new WorkspaceGitError(res.stderr.trim() || "Failed to remove git worktree", 400);
    }
  }

  async deleteBranch(repoRoot: string, branch: string, force = false): Promise<void> {
    const args = ["branch", force ? "-D" : "-d", branch];
    const res = await execGit(repoRoot, args);
    if (!res.ok) {
      throw new WorkspaceGitError(res.stderr.trim() || "Failed to delete git branch", 400);
    }
  }

  async mergeBranch(mainWorktreePath: string, sourceBranch: string): Promise<string> {
    const res = await execGit(mainWorktreePath, ["merge", "--no-ff", sourceBranch]);
    if (!res.ok) {
      // Abort failed merge to leave working tree clean.
      await execGit(mainWorktreePath, ["merge", "--abort"]).catch(() => {});
      throw new WorkspaceGitError(
        res.stderr.trim() || res.stdout.trim() || "Merge conflict or git merge failed",
        409,
      );
    }
    return res.stdout.trim() || `Merged ${sourceBranch}`;
  }
}
