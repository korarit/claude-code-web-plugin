import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeStatus } from "@contracts/changes";
import type { GitChangedFile, GitWorkspacePort } from "../application/ports.ts";
import { isBinaryBytes, splitLines } from "../domain/diff.ts";
import { GitWorkspaceError } from "../domain/errors.ts";

interface GitExecResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

async function execGit(cwd: string, args: string[]): Promise<GitExecResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBuf, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: new Uint8Array(stdoutBuf), stderr };
}

function mapPorcelainStatus(xy: string): FileChangeStatus {
  if (xy.includes("?") || xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  return "modified";
}

function stripPrefix(repoRelPath: string, prefix: string): string | null {
  const normalized = repoRelPath.replace(/\\/g, "/");
  if (!prefix) return normalized;
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
}

export class LocalGitWorkspaceAdapter implements GitWorkspacePort {
  async isGitRepo(cwd: string): Promise<boolean> {
    if (!existsSync(cwd)) return false;
    const res = await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return res.exitCode === 0;
  }

  private async getPrefix(cwd: string): Promise<string> {
    const res = await execGit(cwd, ["rev-parse", "--show-prefix"]);
    if (res.exitCode !== 0) return "";
    return new TextDecoder().decode(res.stdout).trim().replace(/\\/g, "/");
  }

  async listChanges(cwd: string): Promise<GitChangedFile[]> {
    if (!(await this.isGitRepo(cwd))) return [];

    const prefix = await this.getPrefix(cwd);
    const statusRes = await execGit(cwd, ["status", "--porcelain=v1", "-z", "-uall", "--", "."]);
    if (statusRes.exitCode !== 0) return [];

    const hasHead = (await execGit(cwd, ["rev-parse", "--verify", "HEAD"])).exitCode === 0;
    const numstatRes = hasHead
      ? await execGit(cwd, ["diff", "--numstat", "-z", "HEAD", "--", "."])
      : await execGit(cwd, ["diff", "--numstat", "-z", "--", "."]);

    const statsMap = new Map<string, { additions: number; deletions: number }>();
    if (numstatRes.exitCode === 0) {
      const text = new TextDecoder().decode(numstatRes.stdout);
      const tokens = text.split("\0");
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const parts = token.split("\t");
        if (parts.length < 3) continue;
        const add = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
        const del = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
        let repoPath = parts[2] ?? "";
        if (!repoPath) {
          // Rename/copy entry in -z format emits empty path field followed by oldPath\0newPath\0
          const _oldPath = tokens[++i];
          repoPath = tokens[++i] ?? "";
        }
        const rel = stripPrefix(repoPath, prefix);
        if (rel) {
          statsMap.set(rel, { additions: add, deletions: del });
        }
      }
    }

    const rawStatus = new TextDecoder().decode(statusRes.stdout);
    const entries = rawStatus.split("\0").filter(Boolean);
    const results: GitChangedFile[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const rawPathPart = entry.slice(3);

      if (xy.includes("R") || xy.includes("C")) {
        i++;
      }

      const relPath = stripPrefix(rawPathPart, prefix);
      if (!relPath) continue;

      const status = mapPorcelainStatus(xy);
      const stats = statsMap.get(relPath);
      let additions = stats?.additions ?? 0;
      const deletions = stats?.deletions ?? 0;

      if (!stats && status === "added") {
        const abs = join(cwd, relPath);
        if (existsSync(abs)) {
          try {
            const bytes = new Uint8Array(await readFile(abs));
            if (!isBinaryBytes(bytes)) {
              additions = splitLines(new TextDecoder().decode(bytes)).length;
            }
          } catch {
            // Ignore unreadable file.
          }
        }
      }

      results.push({
        path: relPath,
        status,
        additions,
        deletions,
      });
    }

    return results;
  }

  async readHeadFile(cwd: string, relPath: string): Promise<Uint8Array | null> {
    if (!(await this.isGitRepo(cwd))) return null;
    const prefix = await this.getPrefix(cwd);
    const repoPath = `${prefix}${relPath}`;
    const res = await execGit(cwd, ["show", `HEAD:${repoPath}`]);
    if (res.exitCode !== 0) return null;
    return res.stdout;
  }

  async revertFile(cwd: string, relPath: string): Promise<void> {
    if (!(await this.isGitRepo(cwd))) {
      throw new GitWorkspaceError("Workspace is not a git repository");
    }

    const statusRes = await execGit(cwd, ["status", "--porcelain=v1", "--", relPath]);
    const statusLine = new TextDecoder().decode(statusRes.stdout).replace(/\r?\n$/, "");
    const xy = statusLine.slice(0, 2);

    if (xy === "??") {
      const abs = join(cwd, relPath);
      if (existsSync(abs)) {
        await rm(abs, { force: true });
      }
      return;
    }

    const hasHead = (await execGit(cwd, ["rev-parse", "--verify", "HEAD"])).exitCode === 0;
    if (xy.startsWith("A") || !hasHead) {
      await execGit(cwd, ["reset", "HEAD", "--", relPath]);
      const abs = join(cwd, relPath);
      if (xy.startsWith("A") && existsSync(abs)) {
        await rm(abs, { force: true });
      }
      return;
    }

    const res = await execGit(cwd, ["checkout", "HEAD", "--", relPath]);
    if (res.exitCode !== 0) {
      throw new GitWorkspaceError(res.stderr.trim() || `git checkout failed for ${relPath}`);
    }
  }
}
