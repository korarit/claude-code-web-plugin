import type { HarnessId, SessionOrigin } from "@contracts/chat";
import type { Session } from "./session.entity.ts";

export interface SessionFilter {
  archived?: boolean | "all";
  origin?: SessionOrigin;
  harnessId?: HarnessId;
  cwd?: string;
  q?: string;
}

export interface SessionRepository {
  get(id: string): Session | null;
  findByTmuxSession(name: string): Session | null;
  findByTranscriptPath(path: string): Session | null;
  findByExternalSessionId(externalId: string): Session | null;
  save(session: Session): void;
  delete(id: string): boolean;
  list(filter?: SessionFilter): Session[];
}
