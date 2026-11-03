import type { Session } from "./session.entity.ts";

export interface SessionRepository {
  get(id: string): Session | null;
  save(session: Session): void;
  list(): Session[];
}
