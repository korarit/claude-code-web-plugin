import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SafeResolvedPath, WorkspaceFilePort } from "../application/ports.ts";
import { InvalidFilePathError } from "../domain/errors.ts";

function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function nearestExistingRealPath(target: string): string {
  let cursor = target;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return existsSync(cursor) ? realpathSync(cursor) : cursor;
}

export class LocalWorkspaceFilesAdapter implements WorkspaceFilePort {
  async resolveSafePath(cwd: string, targetPath: string): Promise<SafeResolvedPath> {
    if (!targetPath || targetPath.includes("\0")) {
      throw new InvalidFilePathError(targetPath, "empty or null-byte path");
    }

    const absRoot = resolve(cwd);
    const realRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
    const candidate = isAbsolute(targetPath) ? resolve(targetPath) : resolve(absRoot, targetPath);

    if (!isWithinRoot(absRoot, candidate)) {
      throw new InvalidFilePathError(targetPath);
    }

    // Check symlink escape whether target exists or not.
    if (existsSync(candidate) || this.isSymlink(candidate)) {
      if (this.isSymlink(candidate) && !existsSync(candidate)) {
        throw new InvalidFilePathError(targetPath, "dangling symlink is not allowed");
      }
      const realTarget = realpathSync(candidate);
      if (!isWithinRoot(realRoot, realTarget)) {
        throw new InvalidFilePathError(targetPath, "symlink escapes workspace");
      }
      const rel = relative(realRoot, realTarget).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new InvalidFilePathError(targetPath);
      }
      return { absPath: realTarget, relPath: rel };
    }

    const ancestorReal = nearestExistingRealPath(dirname(candidate));
    if (!isWithinRoot(realRoot, ancestorReal)) {
      throw new InvalidFilePathError(targetPath, "ancestor symlink escapes workspace");
    }

    const rel = relative(absRoot, candidate).replace(/\\/g, "/");
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
      throw new InvalidFilePathError(targetPath);
    }
    return { absPath: candidate, relPath: rel };
  }

  private isSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  async readFileBytes(absPath: string): Promise<Uint8Array | null> {
    if (!existsSync(absPath)) return null;
    try {
      const st = lstatSync(absPath);
      if (!st.isFile()) return null;
      const buf = await readFile(absPath);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async writeFileBytes(absPath: string, bytes: Uint8Array): Promise<void> {
    mkdirSync(dirname(absPath), { recursive: true });
    await writeFile(absPath, bytes);
  }

  async removeFile(absPath: string): Promise<void> {
    if (existsSync(absPath)) {
      await rm(absPath, { force: true });
    }
  }
}
