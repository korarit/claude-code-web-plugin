import type { TrackedFileRecord } from "./change-record.entity.ts";

export interface ChangesRepository {
  listBySession(sessionId: string): TrackedFileRecord[];
  get(sessionId: string, relPath: string): TrackedFileRecord | null;
  save(sessionId: string, record: TrackedFileRecord): void;
  delete(sessionId: string, relPath: string): void;
  deleteSession(sessionId: string): void;
}
