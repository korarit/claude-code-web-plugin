import { Elysia, t } from "elysia";
import type { ChatStreamEvent } from "@contracts/chat";
import { AVAILABLE_MODELS } from "@contracts/chat";
import { okResponse } from "@contracts/http";
import { encodeSseEvent } from "@core/utils";
import type { DomainChatEvent } from "../domain/chat.events.ts";
import { SendMessageUsecase } from "../application/send-message.usecase.ts";
import type { RunnerPort } from "../application/ports.ts";
import type { SessionRepository } from "../domain/repository.port.ts";

function toContract(sessionId: string, event: DomainChatEvent): ChatStreamEvent {
  return { sessionId, ...event };
}

export function chatRoutes(runner: RunnerPort, sessions: SessionRepository) {
  const sendMessage = new SendMessageUsecase(sessions, runner);

  return new Elysia()
    .get("/api/health", () => okResponse({ ok: true }))
    .get("/api/models", () => okResponse({ models: [...AVAILABLE_MODELS] }))
    .get("/api/chat/sessions", () => okResponse({ sessions: sessions.list() }))
    .post(
      "/api/chat/send",
      async ({ body }) => {
        const result = await sendMessage.execute({
          prompt: body.prompt,
          sessionId: body.sessionId,
          model: body.model,
        });
        if (!result.ok) throw result.error;

        const { session, events } = result.value;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (type: string, data: unknown) =>
              controller.enqueue(encoder.encode(encodeSseEvent(type, data)));
            try {
              for await (const event of events) {
                send(event.type, toContract(session.id, event));
              }
            } catch (e) {
              send("error", toContract(session.id, { type: "error", message: (e as Error).message }));
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      },
      {
        body: t.Object({
          prompt: t.String(),
          sessionId: t.Optional(t.String()),
          model: t.Optional(t.Union([t.Literal("sonnet"), t.Literal("opus"), t.Literal("haiku")])),
        }),
      },
    );
}
