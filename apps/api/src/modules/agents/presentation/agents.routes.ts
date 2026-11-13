import { Elysia } from "elysia";
import type { ChatStreamEvent } from "@contracts/chat";
import { okResponse } from "@contracts/http";
import { encodeSseEvent } from "@core/utils";
import type { AgentsRepository } from "../domain/agents.repository.port.ts";
import {
  ListSessionAgentsUsecase,
  StreamAgentEventsUsecase,
  toAgentNodeContract,
  type AgentEventPublisherPort,
  type AgentTranscriptEvent,
  type AgentTranscriptWatcherPort,
  type SessionAgentLookupPort,
  type SyncAgentTelemetryUsecase,
} from "../application/index.ts";

export interface AgentsRoutesDeps {
  sessions: SessionAgentLookupPort;
  repo: AgentsRepository;
  watcher: AgentTranscriptWatcherPort;
  publisher: AgentEventPublisherPort;
  syncUsecase: SyncAgentTelemetryUsecase;
}

function toStreamEvent(sessionId: string, agentId: string, ev: AgentTranscriptEvent): ChatStreamEvent {
  return {
    id: ev.id,
    type: ev.type as ChatStreamEvent["type"],
    sessionId,
    agentId,
    role: ev.role,
    text: ev.text,
    tool: ev.tool,
    toolUseId: ev.toolUseId,
    toolInput: ev.toolInput,
    parentToolUseId: ev.parentToolUseId,
    usage: ev.usage,
    costUsd: ev.costUsd,
    model: ev.model,
    message: ev.message,
    agent: ev.agentRecord ? toAgentNodeContract(ev.agentRecord) : undefined,
    timestamp: ev.timestamp,
  };
}

export function agentsRoutes(deps: AgentsRoutesDeps) {
  const listAgents = new ListSessionAgentsUsecase(deps.sessions, deps.repo, deps.syncUsecase);
  const streamAgentEvents = new StreamAgentEventsUsecase(
    deps.sessions,
    deps.repo,
    deps.watcher,
    deps.publisher,
    deps.syncUsecase,
  );

  return new Elysia()
    .get("/api/chat/agents", () => {
      return okResponse(listAgents.listAll());
    })
    .get("/api/chat/sessions/:id/agents", async ({ params }) => {
      const result = await listAgents.execute(params.id);
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .get("/api/chat/sessions/:id/agents/:agentId/events", async ({ params, request }) => {
      const result = await streamAgentEvents.execute(params.id, params.agentId);
      if (!result.ok) throw result.error;

      const { agent, replayEvents, subscribe } = result.value;
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (type: string, payload: ChatStreamEvent) => {
            try {
              controller.enqueue(encoder.encode(encodeSseEvent(type, payload)));
            } catch {
              // Stream already closed.
            }
          };

          send("agent_updated", {
            type: "agent_updated",
            sessionId: params.id,
            agentId: agent.agentId,
            agent: toAgentNodeContract(agent),
            timestamp: agent.updatedAt,
          });

          for (const ev of replayEvents) {
            const mapped = toStreamEvent(params.id, agent.agentId, ev);
            send(mapped.type, mapped);
          }

          unsubscribe = subscribe((ev) => {
            const mapped = toStreamEvent(params.id, agent.agentId, ev);
            send(mapped.type, mapped);
          });

          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              // Stream already closed.
            }
          }, 25_000);

          request.signal.addEventListener("abort", () => {
            unsubscribe?.();
            if (heartbeat) clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // Stream already closed.
            }
          });
        },
        cancel() {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    });
}
