import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotStorePort } from "../application/ports.ts";

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class FileSnapshotStore implements SnapshotStorePort {
  constructor(private readonly snapshotsRoot: string) {
    mkdirSync(this.snapshotsRoot, { recursive: true, mode: 0o700 });
  }

  private sessionDir(sessionId: string): string {
    return join(this.snapshotsRoot, sanitizeSegment(sessionId));
  }

  private snapshotPath(sessionId: string, key: string): string {
    return join(this.sessionDir(sessionId), `${sanitizeSegment(key)}.bin`);
  }

  async saveSnapshot(sessionId: string, key: string, bytes: Uint8Array): Promise<void> {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await writeFile(this.snapshotPath(sessionId, key), bytes, { mode: 0o600 });
  }

  async loadSnapshot(sessionId: string, key: string): Promise<Uint8Array | null> {
    const path = this.snapshotPath(sessionId, key);
    if (!existsSync(path)) return null;
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  async deleteSessionSnapshots(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
