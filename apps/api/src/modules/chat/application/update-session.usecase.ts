import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  archiveSession,
  markStopped,
  renameSession,
  unarchiveSession,
  type Session,
} from "../domain/session.entity.ts";
import { SessionNotFoundError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type {
  EventBusPort,
  HarnessGatewayPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";

export interface UpdateSessionInput {
  sessionId: string;
  title?: string;
  archived?: boolean;
}

export class UpdateSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly clock: Clock = systemClock,
    private readonly harnessGateway?: HarnessGatewayPort,
  ) {}

  async execute(input: UpdateSessionInput): Promise<Result<Session, AppError>> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) return err(new SessionNotFoundError(input.sessionId));

    let next = existing;
    if (input.title !== undefined) {
      next = renameSession(next, input.title, this.clock);
    }

    if (input.archived === true && !next.archivedAt) {
      if (this.harnessGateway) {
        await this.harnessGateway.stopSession(next).catch(() => {});
      } else if (next.tmuxSession) {
        await this.runner.stopSession(next.tmuxSession).catch(() => {});
      }
      this.watcher.unwatch(next.id);
      next = markStopped(next, this.clock);
      next = archiveSession(next, this.clock);
      this.eventBus.publish(next.id, {
        type: "status",
        status: "stopped",
        timestamp: isoNow(this.clock),
      });
    } else if (input.archived === false && next.archivedAt) {
      next = unarchiveSession(next, this.clock);
    }

    this.sessions.save(next);
    this.eventBus.publishListEvent({ type: "upsert", session: next });
    return ok(next);
  }
}
