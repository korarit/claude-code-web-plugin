import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrackedFileRecord } from "../domain/change-record.entity.ts";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";

function sanitizeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class FileChangesRepository implements ChangesRepository {
  private readonly cache = new Map<string, Map<string, TrackedFileRecord>>();

  constructor(private readonly changesDir: string) {
    mkdirSync(this.changesDir, { recursive: true, mode: 0o700 });
  }

  private filePath(sessionId: string): string {
    return join(this.changesDir, `${sanitizeSegment(sessionId)}.json`);
  }

  private loadSessionMap(sessionId: string): Map<string, TrackedFileRecord> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const map = new Map<string, TrackedFileRecord>();
    const path = this.filePath(sessionId);
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as TrackedFileRecord[];
        if (Array.isArray(parsed)) {
          for (const rec of parsed) {
            if (rec && typeof rec.path === "string") {
              map.set(rec.path, rec);
            }
          }
        }
      } catch {
        // Ignore corrupted cache file.
      }
    }
    this.cache.set(sessionId, map);
    return map;
  }

  private flushSessionMap(sessionId: string, map: Map<string, TrackedFileRecord>): void {
    mkdirSync(this.changesDir, { recursive: true, mode: 0o700 });
    const path = this.filePath(sessionId);
    writeFileSync(path, JSON.stringify([...map.values()], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  listBySession(sessionId: string): TrackedFileRecord[] {
    return [...this.loadSessionMap(sessionId).values()];
  }

  get(sessionId: string, relPath: string): TrackedFileRecord | null {
    return this.loadSessionMap(sessionId).get(relPath) ?? null;
  }

  save(sessionId: string, record: TrackedFileRecord): void {
    const map = this.loadSessionMap(sessionId);
    map.set(record.path, record);
    this.flushSessionMap(sessionId, map);
  }

  delete(sessionId: string, relPath: string): void {
    const map = this.loadSessionMap(sessionId);
    if (map.delete(relPath)) {
      this.flushSessionMap(sessionId, map);
    }
  }

  deleteSession(sessionId: string): void {
    this.cache.delete(sessionId);
    const path = this.filePath(sessionId);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }
}
