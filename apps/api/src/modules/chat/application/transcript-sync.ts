import { isoNow, systemClock, type Clock } from "@core/time";
import type { DomainChatEvent } from "../domain/chat.events.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import {
  clearPendingInteraction,
  markRunning,
  recordPrompt,
  setPendingInteraction,
} from "../domain/session.entity.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type { EventBusPort, TranscriptWatcherPort } from "./ports.ts";

export async function watchTranscriptWithSync(
  sessionId: string,
  transcriptPath: string,
  deps: {
    sessions: SessionRepository;
    watcher: TranscriptWatcherPort;
    eventBus: EventBusPort;
    coordinator?: InteractionCoordinator;
    clock?: Clock;
  },
): Promise<void> {
  const { sessions, watcher, eventBus, coordinator, clock = systemClock } = deps;

  await watcher.watch(sessionId, transcriptPath, (event: DomainChatEvent) => {
    const session = sessions.get(sessionId);

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

    if (event.type === "user" && event.text && session && session.origin !== "web") {
      let updated = recordPrompt(session, event.text, clock);
      if (updated.status === "idle" || updated.status === "stopped") {
        updated = markRunning(updated, clock);
      }
      sessions.save(updated);
      eventBus.publishListEvent({ type: "upsert", session: updated });
    }

    eventBus.publish(sessionId, event);
  });
}
