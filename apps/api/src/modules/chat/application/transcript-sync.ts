import { isoNow, systemClock, type Clock } from "@core/time";
import type { DomainChatEvent } from "../domain/chat.events.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import {
  attachExternalSession,
  attachTranscript,
  clearPendingInteraction,
  markIdle,
  markRunning,
  recordPrompt,
  setPendingInteraction,
  type Session,
} from "../domain/session.entity.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  TranscriptWatcherPort,
} from "./ports.ts";

const TRACKED_EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_file",
  "edit_file",
  "edit",
  "write",
  "patch",
  "multiedit",
]);

interface PendingTrackedTool {
  toolName: string;
  toolInput?: unknown;
  model?: string;
  agentId?: string;
}

export interface SyncObservedDeps {
  sessions: SessionRepository;
  eventBus: EventBusPort;
  coordinator?: InteractionCoordinator;
  fileChangeTracker?: FileChangeTrackerPort;
  agentTelemetry?: AgentTelemetryPort;
  clock?: Clock;
}

export function createObservedEventHandler(
  sessionId: string,
  deps: SyncObservedDeps,
): (event: DomainChatEvent) => void {
  const {
    sessions,
    eventBus,
    coordinator,
    fileChangeTracker,
    agentTelemetry,
    clock = systemClock,
  } = deps;
  const trackedTools = new Map<string, PendingTrackedTool>();

  return (event: DomainChatEvent) => {
    let session = sessions.get(sessionId);

    if (session && (event.discoveredExternalSessionId || event.discoveredTranscriptPath)) {
      let updated = session;
      if (event.discoveredExternalSessionId) {
        updated = attachExternalSession(updated, event.discoveredExternalSessionId, clock);
      }
      if (event.discoveredTranscriptPath) {
        updated = attachTranscript(updated, event.discoveredTranscriptPath, clock);
      }
      if (updated !== session) {
        sessions.save(updated);
        eventBus.publishListEvent({ type: "upsert", session: updated });
        session = updated;
      }
      if (event.type === "init" && !event.usage) {
        return;
      }
    }

    if (event.type === "interaction" && event.interaction) {
      const enriched = { ...event.interaction, sessionId };
      coordinator?.setPending(sessionId, enriched);
      if (session) {
        const updated = setPendingInteraction(session, enriched, clock);
        sessions.save(updated);
        eventBus.publishListEvent({ type: "upsert", session: updated });
      }
      eventBus.publish(sessionId, { ...event, interaction: enriched });
      eventBus.publish(sessionId, {
        type: "status",
        status: "waiting_permission",
        timestamp: event.timestamp ?? isoNow(clock),
      });
      return;
    }

    if (event.type === "interaction_resolved") {
      const cleared = coordinator?.clearPending(sessionId, event.interactionId);
      if (session && session.pendingInteraction) {
        let updated = clearPendingInteraction(session, clock);
        if (updated.status === "waiting_permission") {
          updated = markRunning(updated, clock);
        }
        sessions.save(updated);
        eventBus.publishListEvent({ type: "upsert", session: updated });
        eventBus.publish(sessionId, {
          type: "status",
          status: updated.status,
          timestamp: event.timestamp ?? isoNow(clock),
        });
      }
      eventBus.publish(sessionId, {
        ...event,
        interactionId: event.interactionId ?? cleared?.id,
      });
      return;
    }

    if (event.type === "status" && event.status && session) {
      if (event.status === "running" && session.status !== "running") {
        const updated = markRunning(session, clock);
        sessions.save(updated);
        eventBus.publishListEvent({ type: "upsert", session: updated });
      } else if (event.status === "idle" && session.status !== "idle") {
        const updated = markIdle(session, clock);
        sessions.save(updated);
        eventBus.publishListEvent({ type: "upsert", session: updated });
      }
    }

    if (event.type === "user" && event.text && session && session.origin !== "web") {
      let updated = recordPrompt(session, event.text, clock);
      if (updated.status === "idle" || updated.status === "stopped") {
        updated = markRunning(updated, clock);
      }
      sessions.save(updated);
      eventBus.publishListEvent({ type: "upsert", session: updated });
    }

    if (
      fileChangeTracker &&
      session?.cwd &&
      event.type === "tool" &&
      event.tool &&
      TRACKED_EDIT_TOOLS.has(event.tool) &&
      event.toolUseId
    ) {
      const resolvedAgentId = event.agentId ?? event.parentToolUseId ?? undefined;
      trackedTools.set(event.toolUseId, {
        toolName: event.tool,
        toolInput: event.toolInput,
        model: event.model,
        agentId: resolvedAgentId,
      });
      void fileChangeTracker.onPreToolUse({
        sessionId,
        cwd: session.cwd,
        harnessId: session.harnessId,
        model: event.model ?? session.model,
        toolName: event.tool,
        toolUseId: event.toolUseId,
        toolInput: event.toolInput,
        agentId: resolvedAgentId,
      });
    }

    if (
      fileChangeTracker &&
      session?.cwd &&
      event.type === "tool" &&
      event.tool === "tool_result" &&
      event.toolUseId
    ) {
      const meta = trackedTools.get(event.toolUseId);
      if (meta) {
        trackedTools.delete(event.toolUseId);
        void fileChangeTracker.onPostToolUse({
          sessionId,
          cwd: session.cwd,
          harnessId: session.harnessId,
          model: meta.model ?? session.model,
          toolName: meta.toolName,
          toolUseId: event.toolUseId,
          toolInput: meta.toolInput,
          agentId: meta.agentId,
          editedAt: event.timestamp,
        });
      }
    }

    if (agentTelemetry) {
      void agentTelemetry.onTranscriptEvent(sessionId, event).catch(() => {});
    }

    // Subagent-scoped events shouldn't pollute main chat unless needed; agent_updated already emitted by agents module.
    if (event.type === "agent_updated") {
      return;
    }
    if (event.agentId && event.agentId !== "main") {
      return;
    }

    eventBus.publish(sessionId, event);
  };
}

export async function watchTranscriptWithSync(
  sessionId: string,
  transcriptPath: string,
  deps: SyncObservedDeps & { watcher: TranscriptWatcherPort },
): Promise<void> {
  const handler = createObservedEventHandler(sessionId, deps);
  await deps.watcher.watch(sessionId, transcriptPath, handler);
}

export async function observeHarnessSessionWithSync(
  session: Session,
  deps: SyncObservedDeps & {
    harnessGateway?: HarnessGatewayPort;
    watcher: TranscriptWatcherPort;
  },
  options?: { fromBeginning?: boolean },
): Promise<void> {
  const handler = createObservedEventHandler(session.id, deps);
  if (deps.harnessGateway) {
    await deps.harnessGateway.observeEvents(session, handler, options);
    return;
  }
  if (session.transcriptPath) {
    await deps.watcher.watch(session.id, session.transcriptPath, handler, options);
  }
}
