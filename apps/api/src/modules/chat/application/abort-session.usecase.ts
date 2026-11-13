import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import { markIdle, type Session } from "../domain/session.entity.ts";
import { SessionNotFoundError, SessionNotRunningError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { EventBusPort, TerminalRunnerPort } from "./ports.ts";

export class AbortSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly eventBus: EventBusPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(sessionId: string): Promise<Result<Session, AppError>> {
    const existing = this.sessions.get(sessionId);
    if (!existing) return err(new SessionNotFoundError(sessionId));
    if (!existing.tmuxSession) return err(new SessionNotRunningError(sessionId));

    await this.runner.abortSession(existing.tmuxSession);
    const next = markIdle(existing, this.clock);
    this.sessions.save(next);

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
