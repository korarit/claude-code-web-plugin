import type { HarnessId } from "@contracts/harness";
import type {
  AppendCanonicalEventInput,
  CanonicalEvent,
  CanonicalSession,
  HarnessBinding,
} from "./canonical-session.entity.ts";

export interface CanonicalSessionRepository {
  get(canonicalSessionId: string): CanonicalSession | null;
  findByBindingExternalId(harnessId: HarnessId, externalSessionId: string): CanonicalSession | null;
  saveSession(session: CanonicalSession): void;
  upsertBinding(canonicalSessionId: string, binding: HarnessBinding): CanonicalSession | null;
  appendEvent(input: AppendCanonicalEventInput): { event: CanonicalEvent; inserted: boolean };
  listEvents(
    canonicalSessionId: string,
    options?: { afterSeq?: number; limit?: number },
  ): CanonicalEvent[];
  getLatestSeq(canonicalSessionId: string): number;
  deleteSession(canonicalSessionId: string): void;
}
