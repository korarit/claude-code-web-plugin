import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session } from "../domain/session.entity.ts";
import type { SessionFilter, SessionRepository } from "../domain/repository.port.ts";

function matchesFilter(session: Session, filter?: SessionFilter): boolean {
  if (!filter) return true;
  if (filter.archived === false && session.archivedAt) return false;
  if (filter.archived === true && !session.archivedAt) return false;
  if (filter.origin && session.origin !== filter.origin) return false;
  if (filter.harnessId && session.harnessId !== filter.harnessId) return false;
  if (filter.cwd && session.cwd !== filter.cwd) return false;
  if (filter.q) {
    const q = filter.q.toLowerCase();
    const hay = [session.title, session.lastMessagePreview, session.cwd, session.id, session.model]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export class InMemorySessionRepository implements SessionRepository {
  protected readonly store = new Map<string, Session>();

  get(id: string): Session | null {
    return this.store.get(id) ?? null;
  }

  findByTmuxSession(name: string): Session | null {
    for (const s of this.store.values()) {
      if (s.tmuxSession === name) return s;
    }
    return null;
  }

  findByTranscriptPath(path: string): Session | null {
    for (const s of this.store.values()) {
      if (s.transcriptPath === path) return s;
    }
    return null;
  }

  findByExternalSessionId(externalId: string): Session | null {
    for (const s of this.store.values()) {
      if (s.externalSessionId === externalId) return s;
    }
    return null;
  }

  save(session: Session): void {
    this.store.set(session.id, session);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  list(filter?: SessionFilter): Session[] {
    return [...this.store.values()]
      .filter((s) => matchesFilter(s, filter))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}

interface PersistedSessionsFile {
  version: 1;
  sessions: Session[];
}

export class FileSessionRepository extends InMemorySessionRepository {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  override save(session: Session): void {
    super.save(session);
    this.persist();
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.persist();
    return removed;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedSessionsFile> | Session[];
      const items = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
      for (const s of items) {
        if (s && typeof s.id === "string") {
          this.store.set(s.id, {
            ...s,
            harnessId: s.harnessId ?? "claude",
            origin: s.origin ?? "web",
            controlMode: s.controlMode ?? "interactive",
            status: s.status ?? "idle",
            archivedAt: s.archivedAt ?? null,
          });
        }
      }
    } catch {
      // Corrupted file should not crash startup; repository starts empty.
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedSessionsFile = {
      version: 1,
      sessions: [...this.store.values()],
    };
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }
}
