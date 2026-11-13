import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import { clearPendingInteraction, markIdle, type Session } from "../domain/session.entity.ts";
import { SessionNotFoundError, SessionNotRunningError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type { EventBusPort, TerminalRunnerPort } from "./ports.ts";

export class AbortSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly eventBus: EventBusPort,
    private readonly clock: Clock = systemClock,
    private readonly coordinator?: InteractionCoordinator,
  ) {}

  async execute(sessionId: string): Promise<Result<Session, AppError>> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return err(new SessionNotFoundError(sessionId));
    if (!existing.tmuxSession) return err(new SessionNotRunningError(sessionId));

    this.coordinator?.cancelSession(existing.id);
    await this.runner.abortSession(existing.tmuxSession);
    let next = clearPendingInteraction(existing, this.clock);
    next = markIdle(next, this.clock);
    this.sessions.save(next);

    if (existing.pendingInteraction) {
      this.eventBus.publish(next.id, {
        type: "interaction_resolved",
        interactionId: existing.pendingInteraction.id,
        timestamp: isoNow(this.clock),
      });
    }
    this.eventBus.publish(next.id, {
      type: "status",
      status: "idle",
      message: "Interrupted (Ctrl+C)",
      timestamp: isoNow(this.clock),
    });
    this.eventBus.publishListEvent({ type: "upsert", session: next });

    return ok(next);
  }
}
