import type { AuthMode, ConcurrencyWarning, ModelId } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  adoptToInteractive,
  attachExternalSession,
  attachTranscript,
  unarchiveSession,
  type Session,
} from "../domain/session.entity.ts";
import { ApiKeyNotConfiguredError, SessionNotFoundError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  CanonicalSyncPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import type { SendMessageRuntime } from "./send-message.usecase.ts";
import { observeHarnessSessionWithSync, watchTranscriptWithSync } from "./transcript-sync.ts";

export interface ResumeSessionInput {
  sessionId: string;
  model?: ModelId;
  authMode?: AuthMode;
  agentProfile?: string;
}

export interface ResumeSessionOutput {
  session: Session;
  concurrencyWarning?: ConcurrencyWarning;
}

export class ResumeSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly runtime: SendMessageRuntime,
    private readonly clock: Clock = systemClock,
    private readonly coordinator?: InteractionCoordinator,
    private readonly fileChangeTracker?: FileChangeTrackerPort,
    private readonly agentTelemetry?: AgentTelemetryPort,
    private readonly harnessGateway?: HarnessGatewayPort,
    private readonly canonicalSync?: CanonicalSyncPort,
  ) {}

  async execute(input: ResumeSessionInput): Promise<Result<ResumeSessionOutput, AppError>> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) return err(new SessionNotFoundError(input.sessionId));

    const model = input.model ?? existing.model;
    const authMode = input.authMode ?? existing.authMode ?? "machine_default";
    const agentProfile = input.agentProfile?.trim() || existing.agentProfile;

    if (existing.harnessId === "claude" && authMode === "api_key" && !this.runtime.anthropicApiKey) {
      return err(new ApiKeyNotConfiguredError());
    }

    const cwd = existing.cwd || this.runtime.defaultCwd;
    const resumeId = existing.externalSessionId ?? existing.id;

    let tmuxSession: string | undefined;
    let externalSessionId = existing.externalSessionId;
    let transcriptPath = existing.transcriptPath;

    if (this.harnessGateway) {
      const started = await this.harnessGateway.startOrResumeSession(existing.harnessId, {
        sessionId: existing.id,
        model,
        cwd,
        port: this.runtime.port,
        token: this.runtime.token,
        resumeSessionId: resumeId,
        authMode,
        apiKey: authMode === "api_key" ? this.runtime.anthropicApiKey : undefined,
        agentProfile,
        tmuxSessionName: existing.controlMode === "interactive" ? existing.tmuxSession : undefined,
      });
      tmuxSession = started.tmuxSession;
      if (started.externalSessionId) externalSessionId = started.externalSessionId;
      if (started.transcriptPath && !transcriptPath) transcriptPath = started.transcriptPath;
    } else {
      const ensured = await this.runner.ensureSession({
        sessionId: existing.id,
        model,
        cwd,
        port: this.runtime.port,
        token: this.runtime.token,
        resumeSessionId: resumeId,
        authMode,
        apiKey: authMode === "api_key" ? this.runtime.anthropicApiKey : undefined,
        agentProfile,
        tmuxSessionName: existing.controlMode === "interactive" ? existing.tmuxSession : undefined,
      });
      tmuxSession = ensured.tmuxSession;
    }

    let updated = existing.archivedAt ? unarchiveSession(existing, this.clock) : existing;
    updated = adoptToInteractive(
      updated,
      {
        tmuxSession,
        model,
        authMode,
        agentProfile,
      },
      this.clock,
    );
    if (externalSessionId) {
      updated = attachExternalSession(updated, externalSessionId, this.clock);
    }
    if (transcriptPath) {
      updated = attachTranscript(updated, transcriptPath, this.clock);
    }

    this.sessions.save(updated);
    if (this.canonicalSync) {
      await this.canonicalSync.ingestExternalSession(updated).catch(() => {});
    }
    this.eventBus.publishListEvent({ type: "upsert", session: updated });
    this.eventBus.publish(updated.id, {
      type: "status",
      status: "idle",
      timestamp: isoNow(this.clock),
    });

    if (this.harnessGateway) {
      await observeHarnessSessionWithSync(updated, {
        sessions: this.sessions,
        harnessGateway: this.harnessGateway,
        watcher: this.watcher,
        eventBus: this.eventBus,
        coordinator: this.coordinator,
        fileChangeTracker: this.fileChangeTracker,
        agentTelemetry: this.agentTelemetry,
        canonicalSync: this.canonicalSync,
        clock: this.clock,
      });
    } else if (updated.transcriptPath) {
      await watchTranscriptWithSync(updated.id, updated.transcriptPath, {
        sessions: this.sessions,
        watcher: this.watcher,
        eventBus: this.eventBus,
        coordinator: this.coordinator,
        fileChangeTracker: this.fileChangeTracker,
        agentTelemetry: this.agentTelemetry,
        canonicalSync: this.canonicalSync,
        clock: this.clock,
      });
    }

    const softLimit = this.runtime.concurrencySoftLimit ?? 3;
    const activeCount = this.sessions
      .list({ archived: false })
      .filter(
        (s) =>
          (s.authMode ?? "machine_default") === "machine_default" &&
          (s.status === "running" || s.status === "waiting_permission"),
      ).length;

    const concurrencyWarning: ConcurrencyWarning | undefined =
      authMode === "machine_default" && activeCount >= softLimit
        ? { activeCount, limit: softLimit }
        : undefined;

    return ok({ session: updated, concurrencyWarning });
  }
}
