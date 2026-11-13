import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import { SessionNotFoundError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";

export class DeleteSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly coordinator?: InteractionCoordinator,
    private readonly fileChangeTracker?: FileChangeTrackerPort,
    private readonly agentTelemetry?: AgentTelemetryPort,
    private readonly harnessGateway?: HarnessGatewayPort,
  ) {}

  async execute(sessionId: string): Promise<Result<{ deleted: true; id: string }, AppError>> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return err(new SessionNotFoundError(sessionId));

    this.coordinator?.cancelSession(existing.id);
    if (this.harnessGateway) {
      await this.harnessGateway.stopSession(existing).catch(() => {});
    } else if (existing.tmuxSession) {
      await this.runner.stopSession(existing.tmuxSession).catch(() => {});
    }
    this.watcher.unwatch(existing.id);
    await this.fileChangeTracker?.deleteSession?.(existing.id).catch(() => {});
    this.agentTelemetry?.deleteSession?.(existing.id);
    this.sessions.delete(existing.id);
    this.eventBus.clearSession(existing.id);
    this.eventBus.publishListEvent({ type: "delete", sessionId: existing.id });

    return ok({ deleted: true, id: existing.id });
  }
}
