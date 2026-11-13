import type { HarnessId } from "@contracts/harness";
import type { SwitchHarnessResponse } from "@contracts/sync";
import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import {
  CanonicalSessionNotFoundError,
  HarnessSwitchBusyError,
  HarnessSwitchUnavailableError,
} from "../domain/errors.ts";
import type { CanonicalSyncService } from "./canonical-sync.service.ts";
import type { ExternalSessionIngestService } from "./external-session-ingest.service.ts";
import type {
  SyncEventPublisherPort,
  SyncHarnessGatewayPort,
  SyncSessionBridgePort,
} from "./ports.ts";

export interface SwitchHarnessInput {
  sessionId: string;
  harnessId: HarnessId;
  model?: string;
  agentProfile?: string;
}

export class SwitchHarnessUsecase {
  constructor(
    private readonly sessionBridge: SyncSessionBridgePort,
    private readonly harnessGateway: SyncHarnessGatewayPort,
    private readonly canonicalSync: CanonicalSyncService,
    private readonly publisher: SyncEventPublisherPort,
    private readonly externalIngest?: ExternalSessionIngestService,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: SwitchHarnessInput): Promise<Result<SwitchHarnessResponse, AppError>> {
    const existing = this.sessionBridge.getSession(input.sessionId);
    if (!existing) {
      return err(new CanonicalSessionNotFoundError(input.sessionId));
    }

    if (
      existing.controlMode === "interactive" &&
      (existing.status === "running" || existing.status === "waiting_permission")
    ) {
      return err(new HarnessSwitchBusyError(existing.id, existing.status));
    }

    const available = await this.harnessGateway.isAvailable(input.harnessId);
    if (!available) {
      return err(new HarnessSwitchUnavailableError(input.harnessId));
    }

    // Ensure canonical store has full history from the current harness before switching away.
    if (this.externalIngest) {
      await this.externalIngest.ingestSession(existing);
    } else {
      this.canonicalSync.ensureSession({
        sessionId: existing.id,
        harnessId: existing.harnessId,
        origin: existing.origin,
        controlMode: existing.controlMode,
        cwd: existing.cwd,
        title: existing.title,
        model: existing.model,
        externalSessionId: existing.externalSessionId,
        tmuxSession: existing.tmuxSession,
        transcriptPath: existing.transcriptPath,
      });
    }

    const targetBinding = this.canonicalSync.getBinding(existing.id, input.harnessId);
    const targetModel =
      input.model?.trim() ||
      targetBinding?.model ||
      (existing.harnessId === input.harnessId
        ? existing.model
        : this.harnessGateway.getDefaultModel(input.harnessId));

    const fromHarness = existing.harnessId;
    if (fromHarness !== input.harnessId) {
      this.publisher.unwatchPreviousObserver?.(existing.id);
    }

    const recorded = this.canonicalSync.recordHarnessSwitch({
      sessionId: existing.id,
      fromHarness,
      toHarness: input.harnessId,
      targetModel,
    });
    if (!recorded) {
      return err(new CanonicalSessionNotFoundError(existing.id));
    }

    const updatedSession = this.sessionBridge.applyHarnessSwitch({
      sessionId: existing.id,
      harnessId: input.harnessId,
      model: targetModel,
      agentProfile: input.agentProfile?.trim() || undefined,
      externalSessionId: targetBinding?.externalSessionId,
      tmuxSession: targetBinding?.tmuxSession,
      transcriptPath: targetBinding?.transcriptPath,
      adoptInteractive: true,
    });
    if (!updatedSession) {
      return err(new CanonicalSessionNotFoundError(existing.id));
    }

    const ts = recorded.switchEvent.ts || isoNow(this.clock);
    this.publisher.publishChatEvent(existing.id, {
      id: recorded.switchEvent.id,
      type: "harness_switched",
      harnessId: input.harnessId,
      switchedFrom: fromHarness,
      switchedTo: input.harnessId,
      syncedTurnsRange: recorded.switchEvent.syncedTurnsRange,
      model: targetModel,
      text: recorded.switchEvent.text,
      canonicalSeq: recorded.switchEvent.seq,
      timestamp: ts,
    });
    this.publisher.publishSessionUpsert(updatedSession);

    const { sourceKey: _sourceKey, ...switchDto } = recorded.switchEvent;

    return ok({
      session: {
        ...updatedSession,
        syncSummary: recorded.summary,
      },
      sync: recorded.summary,
      switchEvent: switchDto,
    });
  }
}
