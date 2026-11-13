import type { SessionOrigin } from "@contracts/chat";
import { newSessionId } from "@core/ids";
import { isoNow, systemClock, type Clock } from "@core/time";
import {
  attachTmuxSession,
  attachTranscript,
  createSession,
  markIdle,
  markStopped,
  type Session,
} from "../domain/session.entity.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  EventBusPort,
  FileChangeTrackerPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import { watchTranscriptWithSync } from "./transcript-sync.ts";

export interface DiscoveredSessionInput {
  externalSessionId: string;
  transcriptPath?: string;
  cwd?: string;
  origin: SessionOrigin;
  tmuxSession?: string;
  lastMessagePreview?: string;
  messageCount?: number;
  isActiveTmux?: boolean;
}

export class DiscoverSessionUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly clock: Clock = systemClock,
    private readonly coordinator?: InteractionCoordinator,
    private readonly fileChangeTracker?: FileChangeTrackerPort,
    private readonly agentTelemetry?: AgentTelemetryPort,
  ) {}

  async execute(input: DiscoveredSessionInput): Promise<Session> {
    const existing =
      this.sessions.findByExternalSessionId(input.externalSessionId) ??
      this.sessions.get(input.externalSessionId) ??
      (input.transcriptPath ? this.sessions.findByTranscriptPath(input.transcriptPath) : null) ??
      (input.tmuxSession ? this.sessions.findByTmuxSession(input.tmuxSession) : null);

    if (existing) {
      let updated = existing;
      let changed = false;

      if (input.transcriptPath && !updated.transcriptPath) {
        updated = attachTranscript(updated, input.transcriptPath, this.clock);
        changed = true;
      }
      if (input.tmuxSession && updated.tmuxSession !== input.tmuxSession) {
        updated = attachTmuxSession(updated, input.tmuxSession, this.clock);
        changed = true;
      }
      if (
        input.lastMessagePreview &&
        (!updated.lastMessagePreview || updated.lastMessagePreview !== input.lastMessagePreview)
      ) {
        updated = {
          ...updated,
          lastMessagePreview: input.lastMessagePreview,
          messageCount: Math.max(updated.messageCount, input.messageCount ?? 0),
        };
        changed = true;
      }
      if (updated.tmuxSession && input.isActiveTmux === false && updated.status !== "stopped") {
        updated = markStopped(updated, this.clock);
        changed = true;
      } else if (updated.tmuxSession && input.isActiveTmux === true && updated.status === "stopped") {
        updated = markIdle(updated, this.clock);
        changed = true;
      }

      if (changed) {
        this.sessions.save(updated);
        this.eventBus.publishListEvent({ type: "upsert", session: updated });
      }
      return updated;
    }

    const isTmux = input.origin === "tmux" && Boolean(input.tmuxSession);
    const created = createSession(
      {
        id: newSessionId(),
        model: "sonnet",
        harnessId: "claude",
        origin: input.origin,
        controlMode: isTmux ? "interactive" : "mirror",
        status: isTmux ? (input.isActiveTmux ? "idle" : "stopped") : "idle",
        externalSessionId: input.externalSessionId,
        discoveredAt: isoNow(this.clock),
        tmuxSession: isTmux ? input.tmuxSession : undefined,
        transcriptPath: input.transcriptPath,
        cwd: input.cwd,
        lastMessagePreview: input.lastMessagePreview,
        messageCount: input.messageCount ?? 0,
      },
      this.clock,
    );

    this.sessions.save(created);
    this.eventBus.publishListEvent({ type: "upsert", session: created });

    if (created.transcriptPath) {
      await watchTranscriptWithSync(created.id, created.transcriptPath, {
        sessions: this.sessions,
        watcher: this.watcher,
        eventBus: this.eventBus,
        coordinator: this.coordinator,
        fileChangeTracker: this.fileChangeTracker,
        agentTelemetry: this.agentTelemetry,
        clock: this.clock,
      });
    }

    return created;
  }
}
