import { Elysia, t } from "elysia";
import type {
  ChatStreamEvent,
  HarnessId,
  SessionInfo,
  SessionOrigin,
  SessionsListEvent,
} from "@contracts/chat";
import { AVAILABLE_MODELS } from "@contracts/chat";
import { okResponse } from "@contracts/http";
import { encodeSseEvent } from "@core/utils";
import type { DomainChatEvent, SessionListEvent } from "../domain/chat.events.ts";
import { SessionNotFoundError } from "../domain/errors.ts";
import type { SessionFilter, SessionRepository } from "../domain/repository.port.ts";
import type { Session } from "../domain/session.entity.ts";
import {
  AbortSessionUsecase,
  DeleteSessionUsecase,
  HandleHookUsecase,
  SendMessageUsecase,
  UpdateSessionUsecase,
  type EventBusPort,
  type SendMessageRuntime,
  type TerminalRunnerPort,
  type TranscriptWatcherPort,
} from "../application/index.ts";

function toChatContract(sessionId: string, event: DomainChatEvent): ChatStreamEvent {
  return { sessionId, ...event };
}

function toSessionInfo(session: Session): SessionInfo {
  return { ...session };
}

function toListContract(event: SessionListEvent): SessionsListEvent {
  return {
    type: event.type,
    session: event.session ? toSessionInfo(event.session) : undefined,
    sessionId: event.sessionId,
  };
}

export interface ChatRoutesDeps {
  sessions: SessionRepository;
  runner: TerminalRunnerPort;
  watcher: TranscriptWatcherPort;
  eventBus: EventBusPort;
  runtime: SendMessageRuntime;
}

export function chatRoutes(deps: ChatRoutesDeps) {
  const { sessions, runner, watcher, eventBus, runtime } = deps;
  const sendMessage = new SendMessageUsecase(sessions, runner, watcher, eventBus, runtime);
  const handleHook = new HandleHookUsecase(sessions, watcher, eventBus, runner);
  const updateSession = new UpdateSessionUsecase(sessions, runner, watcher, eventBus);
  const abortSession = new AbortSessionUsecase(sessions, runner, eventBus);
  const deleteSession = new DeleteSessionUsecase(sessions, runner, watcher, eventBus);

  return new Elysia()
    .get("/api/health", async () =>
      okResponse({
        ok: true,
        tmuxAvailable: await runner.isAvailable(),
        defaultCwd: runtime.defaultCwd,
      }),
    )
    .get("/api/models", () => okResponse({ models: [...AVAILABLE_MODELS] }))
    .get("/api/chat/sessions", ({ query }) => {
      const archivedParam = query["archived"];
      let archived: SessionFilter["archived"] = "all";
      if (archivedParam === "true") archived = true;
      else if (archivedParam === "false") archived = false;

      const list = sessions.list({
        archived,
        origin: query["origin"] as SessionOrigin | undefined,
        harnessId: query["harness"] as HarnessId | undefined,
        cwd: query["cwd"] || undefined,
        q: query["q"] || undefined,
      });
      return okResponse({ sessions: list.map(toSessionInfo) });
    })
    .get("/api/chat/sessions/events", ({ request }) => {
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (type: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode(encodeSseEvent(type, data)));
            } catch {
              // Stream already closed.
            }
          };

          const snapshot: SessionsListEvent = {
            type: "snapshot",
            sessions: sessions.list({ archived: "all" }).map(toSessionInfo),
          };
          send("snapshot", snapshot);

          unsubscribe = eventBus.subscribeListEvents((event) => {
            const payload = toListContract(event);
            send(payload.type, payload);
          });

          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              // Ignore closed stream.
            }
          }, 25_000);

          request.signal.addEventListener("abort", () => {
            unsubscribe?.();
            if (heartbeat) clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // Already closed.
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
    })
    .get("/api/chat/sessions/:id/events", async ({ params, request }) => {
      const session = sessions.get(params.id);
      if (!session) throw new SessionNotFoundError(params.id);

      const diskEvents = session.transcriptPath
        ? await watcher.readRecentEvents(session.transcriptPath).catch(() => [])
        : [];
      const recentEvents =
        diskEvents.length > 0 ? diskEvents : eventBus.getRecentEvents(session.id);

      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: DomainChatEvent) => {
            try {
              controller.enqueue(
                encoder.encode(encodeSseEvent(event.type, toChatContract(session.id, event))),
              );
            } catch {
              // Stream already closed.
            }
          };

          send({ type: "status", status: session.status, timestamp: session.updatedAt });
          for (const item of recentEvents) {
            send(item);
          }

          unsubscribe = eventBus.subscribe(session.id, (event) => {
            send(event);
          });

          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              // Ignore closed stream.
            }
          }, 25_000);

          request.signal.addEventListener("abort", () => {
            unsubscribe?.();
            if (heartbeat) clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // Already closed.
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
    })
    .post(
      "/api/chat/send",
      async ({ body, set }) => {
        const result = await sendMessage.execute({
          prompt: body.prompt,
          sessionId: body.sessionId,
          model: body.model,
          cwd: body.cwd,
        });
        if (!result.ok) throw result.error;

        set.status = 202;
        return okResponse({
          session: toSessionInfo(result.value.session),
          isNewSession: result.value.isNewSession,
        });
      },
      {
        body: t.Object({
          prompt: t.String(),
          sessionId: t.Optional(t.String()),
          model: t.Optional(t.Union([t.Literal("sonnet"), t.Literal("opus"), t.Literal("haiku")])),
          cwd: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/api/chat/sessions/:id",
      async ({ params, body }) => {
        const result = await updateSession.execute({
          sessionId: params.id,
          title: body.title,
          archived: body.archived,
        });
        if (!result.ok) throw result.error;
        return okResponse({ session: toSessionInfo(result.value) });
      },
      {
        body: t.Object({
          title: t.Optional(t.String()),
          archived: t.Optional(t.Boolean()),
        }),
      },
    )
    .post("/api/chat/sessions/:id/abort", async ({ params }) => {
      const result = await abortSession.execute(params.id);
      if (!result.ok) throw result.error;
      return okResponse({ session: toSessionInfo(result.value) });
    })
    .delete("/api/chat/sessions/:id", async ({ params }) => {
      const result = await deleteSession.execute(params.id);
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .post("/api/chat/hooks", async ({ body, request }) => {
      const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const headerSessionId = request.headers.get("x-claude-web-session-id") ?? undefined;
      const hookEventName =
        typeof payload["hook_event_name"] === "string"
          ? payload["hook_event_name"]
          : typeof payload["hookEventName"] === "string"
            ? payload["hookEventName"]
            : "";

      const result = await handleHook.execute({
        sessionId: headerSessionId,
        externalSessionId:
          typeof payload["session_id"] === "string" ? payload["session_id"] : undefined,
        tmuxSession:
          typeof payload["tmux_session"] === "string" ? payload["tmux_session"] : undefined,
        transcriptPath:
          typeof payload["transcript_path"] === "string" ? payload["transcript_path"] : undefined,
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : undefined,
        hookEventName,
        toolName: typeof payload["tool_name"] === "string" ? payload["tool_name"] : undefined,
        toolInput: payload["tool_input"],
        message: typeof payload["message"] === "string" ? payload["message"] : undefined,
      });
      if (!result.ok) throw result.error;
      return okResponse({ matched: result.value.matched });
    });
}
