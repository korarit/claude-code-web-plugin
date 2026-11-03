import type { ModelId } from "@contracts/chat";
import { isoNow, type Clock } from "@core/time";

export interface Session {
  id: string;
  model: ModelId;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export function createSession(id: string, model: ModelId, clock: Clock): Session {
  const now = isoNow(clock);
  return { id, model, createdAt: now, updatedAt: now, messageCount: 0 };
}

export function touchSession(session: Session, model: ModelId, clock: Clock): Session {
  return {
    ...session,
    model,
    updatedAt: isoNow(clock),
    messageCount: session.messageCount + 1,
  };
}
