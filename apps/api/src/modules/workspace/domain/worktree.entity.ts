import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeRecord {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  isBare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

export function sanitizeBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._/-]/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\.+/g, "");
}

export function deriveDefaultWorktreePath(repoRoot: string, branch: string): string {
  const safeSlug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
  const repoName = basename(repoRoot) || "repo";
  return resolve(join(dirname(repoRoot), ".harness-worktrees", repoName, safeSlug));
}

export function parseGitWorktreePorcelain(output: string): WorktreeRecord[] {
  const blocks = output
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const records: WorktreeRecord[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i]!.split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    let isBare = false;
    let locked = false;
    let prunable = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "bare") {
        isBare = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (!path) continue;
    records.push({
      path,
      branch,
      head,
      isMain: i === 0,
      isBare,
      locked,
      prunable,
    });
  }

  return records;
}
