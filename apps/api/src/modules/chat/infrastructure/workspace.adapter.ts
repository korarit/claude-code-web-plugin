import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { UploadImageResponse, WorkspaceFileEntry } from "@contracts/chat";
import type { WorkspacePort } from "../application/ports.ts";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".harness-web",
]);

export class LocalWorkspaceAdapter implements WorkspacePort {
  async listFiles(cwd: string, query?: string, limit = 50): Promise<WorkspaceFileEntry[]> {
    const root = resolve(cwd);
    if (!existsSync(root)) return [];

    const q = query?.trim().toLowerCase() ?? "";
    const results: WorkspaceFileEntry[] = [];
    const maxDepth = 5;

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || results.length >= limit * 3) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        const isDir = entry.isDirectory();

        if (!q || rel.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)) {
          results.push({ path: rel, name: entry.name, isDir });
        }

        if (isDir) {
          walk(full, depth + 1);
        }
      }
    };

    walk(root, 0);
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return results.slice(0, limit);
  }

  async saveImage(
    cwd: string,
    filename: string,
    bytes: Uint8Array,
  ): Promise<UploadImageResponse> {
    const root = resolve(cwd);
    const uploadsDir = join(root, ".harness-web", "uploads");
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

    const safeBase = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "image.png";
    const stamped = `${Date.now()}-${safeBase}`;
    const fullPath = join(uploadsDir, stamped);
    writeFileSync(fullPath, bytes, { mode: 0o600 });

    return {
      path: fullPath,
      filename: stamped,
      size: bytes.byteLength,
    };
  }
}
