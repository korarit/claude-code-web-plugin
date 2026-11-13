import type { HarnessId } from "@contracts/harness";
import type {
  AppendCanonicalEventInput,
  CanonicalEvent,
  CanonicalSession,
  HarnessBinding,
} from "./canonical-session.entity.ts";

export interface BindingLookupParams {
  harnessId?: HarnessId;
  externalSessionId?: string;
  transcriptPath?: string;
}

export interface UpsertStreamingDeltaInput {
  canonicalSessionId: string;
  sourceKey: string;
  id: string;
  harnessId: HarnessId;
  model?: string;
  text: string;
  offset: number;
  ts: string;
}

export interface CanonicalSessionRepository {
  get(canonicalSessionId: string): CanonicalSession | null;
  findByBindingExternalId(harnessId: HarnessId, externalSessionId: string): CanonicalSession | null;
  findByBinding(params: BindingLookupParams): CanonicalSession | null;
  saveSession(session: CanonicalSession): void;
  upsertBinding(canonicalSessionId: string, binding: HarnessBinding): CanonicalSession | null;
  appendEvent(input: AppendCanonicalEventInput): { event: CanonicalEvent; inserted: boolean };
  upsertStreamingDelta(input: UpsertStreamingDeltaInput): { event: CanonicalEvent; inserted: boolean };
  attachSourceKey(canonicalSessionId: string, seq: number, sourceKey: string): void;
  listEvents(
    canonicalSessionId: string,
    options?: { afterSeq?: number; limit?: number },
  ): CanonicalEvent[];
  getLatestSeq(canonicalSessionId: string): number;
  deleteSession(canonicalSessionId: string): void;
}
