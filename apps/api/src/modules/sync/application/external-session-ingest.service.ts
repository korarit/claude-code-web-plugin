import type { CanonicalSyncService, EnsureCanonicalSessionInput } from "./canonical-sync.service.ts";
import type { RawNormalizableEvent } from "./canonical-event-normalizer.ts";
import type { SyncHarnessGatewayPort, SyncSessionState } from "./ports.ts";

export class ExternalSessionIngestService {
  constructor(
    private readonly canonicalSync: CanonicalSyncService,
    private readonly harnessGateway?: SyncHarnessGatewayPort,
  ) {}

  async ingestSession(
    session: SyncSessionState,
    preloadedEvents?: RawNormalizableEvent[],
  ): Promise<{ insertedCount: number; latestSeq: number }> {
    const sessionInput: EnsureCanonicalSessionInput = {
      sessionId: session.id,
      harnessId: session.harnessId,
      origin: session.origin,
      controlMode: session.controlMode,
      cwd: session.cwd,
      title: session.title,
      model: session.model,
      externalSessionId: session.externalSessionId,
      tmuxSession: session.tmuxSession,
      transcriptPath: session.transcriptPath,
    };

    this.canonicalSync.ensureSession(sessionInput);

    let events = preloadedEvents;
    if (!events && this.harnessGateway?.readRecentEvents) {
      events = await this.harnessGateway.readRecentEvents(session, 1000).catch(() => []);
    }

    if (!events || events.length === 0) {
      const history = this.canonicalSync.getCanonicalHistory(session.id, 1);
      return { insertedCount: 0, latestSeq: history?.sync.latestSeq ?? 0 };
    }

    return this.canonicalSync.ingestHistory(sessionInput, events, true);
  }
}
