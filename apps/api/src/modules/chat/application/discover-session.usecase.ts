import type { HarnessId, SessionControlMode, SessionOrigin } from "@contracts/chat";
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
  CanonicalSyncPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import { observeHarnessSessionWithSync, watchTranscriptWithSync } from "./transcript-sync.ts";

export interface DiscoveredSessionInput {
  externalSessionId: string;
  harnessId?: HarnessId;
  transcriptPath?: string;
  cwd?: string;
  origin: SessionOrigin;
  controlMode?: SessionControlMode;
  tmuxSession?: string;
  model?: string;
  title?: string;
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
    private readonly harnessGateway?: HarnessGatewayPort,
    private readonly canonicalSync?: CanonicalSyncPort,
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
      if (input.title && !updated.title) {
        updated = { ...updated, title: input.title };
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
        if (this.canonicalSync) {
          await this.canonicalSync.ingestExternalSession(updated).catch(() => {});
        }
        this.eventBus.publishListEvent({ type: "upsert", session: updated });
      }
      return updated;
    }

    const harnessId: HarnessId = input.harnessId ?? "claude";
    const isTmux = input.origin === "tmux" && Boolean(input.tmuxSession);
    const controlMode: SessionControlMode =
      input.controlMode ?? (isTmux ? "interactive" : "mirror");
    const defaultModel =
      input.model ??
      this.harnessGateway?.getDefaultModel(harnessId) ??
      (harnessId === "agy"
        ? "gemini-2.5-pro"
        : harnessId === "opencode"
          ? "anthropic/claude-sonnet-4-5"
          : "sonnet");

    const created = createSession(
      {
        id: newSessionId(),
        title: input.title,
        model: defaultModel,
        harnessId,
        origin: input.origin,
        controlMode,
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
    if (this.canonicalSync) {
      await this.canonicalSync.ingestExternalSession(created).catch(() => {});
    }
    this.eventBus.publishListEvent({ type: "upsert", session: created });

    if (this.harnessGateway && (created.transcriptPath || created.harnessId === "opencode")) {
      await observeHarnessSessionWithSync(created, {
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
    } else if (created.transcriptPath) {
      await watchTranscriptWithSync(created.id, created.transcriptPath, {
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

    return created;
  }

  reconcileStaleExternalTmux(seenExternalIds: Set<string>): void {
    for (const session of this.sessions.list({ archived: false })) {
      if (!session.externalSessionId?.startsWith("tmux:")) continue;
      if (session.status === "stopped") continue;
      if (!seenExternalIds.has(session.externalSessionId)) {
        const stopped = markStopped(session, this.clock);
        this.sessions.save(stopped);
        this.eventBus.publishListEvent({ type: "upsert", session: stopped });
      }
    }
  }
}
