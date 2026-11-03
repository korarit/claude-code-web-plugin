import type { Session } from "../domain/session.entity.ts";
import type { SessionRepository } from "../domain/repository.port.ts";

export class InMemorySessionRepository implements SessionRepository {
  private readonly store = new Map<string, Session>();

  get(id: string): Session | null {
    return this.store.get(id) ?? null;
  }

  save(session: Session): void {
    this.store.set(session.id, session);
  }

  list(): Session[] {
    return [...this.store.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}
