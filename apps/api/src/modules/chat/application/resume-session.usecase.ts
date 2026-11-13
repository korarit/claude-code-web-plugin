import type { AuthMode, ConcurrencyWarning, ModelId } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  adoptToInteractive,
  unarchiveSession,
  type Session,
} from "../domain/session.entity.ts";
import { ApiKeyNotConfiguredError, SessionNotFoundError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type { EventBusPort, TerminalRunnerPort, TranscriptWatcherPort } from "./ports.ts";
import type { SendMessageRuntime } from "./send-message.usecase.ts";
import { watchTranscriptWithSync } from "./transcript-sync.ts";

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
  ) {}

  async execute(input: ResumeSessionInput): Promise<Result<ResumeSessionOutput, AppError>> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) return err(new SessionNotFoundError(input.sessionId));

    const model = input.model ?? existing.model;
    const authMode = input.authMode ?? existing.authMode ?? "machine_default";
    const agentProfile = input.agentProfile?.trim() || existing.agentProfile;

    if (authMode === "api_key" && !this.runtime.anthropicApiKey) {
      return err(new ApiKeyNotConfiguredError());
    }

    const cwd = existing.cwd || this.runtime.defaultCwd;
    const resumeId = existing.externalSessionId ?? existing.id;

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

    let updated = existing.archivedAt ? unarchiveSession(existing, this.clock) : existing;
    updated = adoptToInteractive(
      updated,
      {
        tmuxSession: ensured.tmuxSession,
        model,
        authMode,
        agentProfile,
      },
      this.clock,
    );

    this.sessions.save(updated);
    this.eventBus.publishListEvent({ type: "upsert", session: updated });
    this.eventBus.publish(updated.id, {
      type: "status",
      status: "idle",
      timestamp: isoNow(this.clock),
    });

    if (updated.transcriptPath) {
      await watchTranscriptWithSync(updated.id, updated.transcriptPath, {
        sessions: this.sessions,
        watcher: this.watcher,
        eventBus: this.eventBus,
        coordinator: this.coordinator,
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
