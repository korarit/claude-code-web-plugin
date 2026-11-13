import { Elysia, t } from "elysia";
import type {
  AuthMode,
  ChatInputType,
  ChatStreamEvent,
  HarnessId,
  PermissionDecision,
  SessionInfo,
  SessionOrigin,
  SessionsListEvent,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@contracts/chat";
import { AVAILABLE_MODELS } from "@contracts/chat";
import { okResponse } from "@contracts/http";
import { encodeSseEvent, safeJsonParse } from "@core/utils";
import { systemClock } from "@core/time";
import type { DomainChatEvent, SessionListEvent } from "../domain/chat.events.ts";
import { SessionNotFoundError } from "../domain/errors.ts";
import type { SessionFilter, SessionRepository } from "../domain/repository.port.ts";
import type { Session } from "../domain/session.entity.ts";
import {
  AbortSessionUsecase,
  DeleteSessionUsecase,
  HandleHookUsecase,
  InteractionCoordinator,
  ListWorkspaceFilesUsecase,
  ResumeSessionUsecase,
  SendInputUsecase,
  SendMessageUsecase,
  UpdateSessionUsecase,
  UploadImageUsecase,
  type EventBusPort,
  type FileChangeTrackerPort,
  type SendMessageRuntime,
  type TerminalAttachment,
  type TerminalAttachPort,
  type TerminalRunnerPort,
  type TranscriptWatcherPort,
  type WorkspacePort,
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

function buildHookOutput(decision: PermissionDecision | "timeout" | undefined) {
  if (!decision || decision === "timeout") return undefined;
  if (decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Denied from Harness Web UI",
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
      },
    },
  };
}

export interface ChatRoutesDeps {
  sessions: SessionRepository;
  runner: TerminalRunnerPort;
  watcher: TranscriptWatcherPort;
  eventBus: EventBusPort;
  runtime: SendMessageRuntime;
  coordinator?: InteractionCoordinator;
  terminalAttach: TerminalAttachPort;
  workspace: WorkspacePort;
  fileChangeTracker?: FileChangeTrackerPort;
}

export function chatRoutes(deps: ChatRoutesDeps) {
  const {
    sessions,
    runner,
    watcher,
    eventBus,
    runtime,
    terminalAttach,
    workspace,
    fileChangeTracker,
  } = deps;
  const coordinator = deps.coordinator ?? new InteractionCoordinator();

  const sendMessage = new SendMessageUsecase(
    sessions,
    runner,
    watcher,
    eventBus,
    runtime,
    systemClock,
    coordinator,
    fileChangeTracker,
  );
  const handleHook = new HandleHookUsecase(
    sessions,
    watcher,
    eventBus,
    runner,
    systemClock,
    coordinator,
    runtime.permissionHookTimeoutMs ?? 55_000,
    fileChangeTracker,
  );
  const sendInput = new SendInputUsecase(sessions, runner, eventBus, coordinator, systemClock);
  const resumeSession = new ResumeSessionUsecase(
    sessions,
    runner,
    watcher,
    eventBus,
    runtime,
    systemClock,
    coordinator,
    fileChangeTracker,
  );
  const updateSession = new UpdateSessionUsecase(sessions, runner, watcher, eventBus);
  const abortSession = new AbortSessionUsecase(
    sessions,
    runner,
    eventBus,
    systemClock,
    coordinator,
  );
  const deleteSession = new DeleteSessionUsecase(
    sessions,
    runner,
    watcher,
    eventBus,
    coordinator,
    fileChangeTracker,
  );
  const listWorkspaceFiles = new ListWorkspaceFilesUsecase(workspace, runtime.defaultCwd);
  const uploadImage = new UploadImageUsecase(workspace, runtime.defaultCwd);

  const terminalAttachments = new WeakMap<object, TerminalAttachment>();

  return new Elysia()
    .get("/api/health", async () =>
      okResponse({
        ok: true,
        tmuxAvailable: await runner.isAvailable(),
        defaultCwd: runtime.defaultCwd,
        apiKeyConfigured: Boolean(runtime.anthropicApiKey),
        concurrencySoftLimit: runtime.concurrencySoftLimit ?? 3,
      }),
    )
    .get("/api/models", () => okResponse({ models: [...AVAILABLE_MODELS] }))
    .get("/api/workspace/files", async ({ query }) => {
      const limitNum = query["limit"] ? Number(query["limit"]) : 50;
      const result = await listWorkspaceFiles.execute({
        cwd: query["cwd"] || undefined,
        query: query["q"] || undefined,
        limit: Number.isFinite(limitNum) ? Math.min(200, Math.max(1, limitNum)) : 50,
      });
      if (!result.ok) throw result.error;
      return okResponse({ files: result.value });
    })
    .post("/api/chat/upload", async ({ request }) => {
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        const cwdField = form.get("cwd");
        const cwd = typeof cwdField === "string" && cwdField.trim() ? cwdField.trim() : undefined;

        if (!(file instanceof File)) {
          const uploadRes = await uploadImage.execute({
            cwd,
            filename: "upload.png",
            bytes: new Uint8Array(0),
          });
          if (!uploadRes.ok) throw uploadRes.error;
          return okResponse(uploadRes.value);
        }

        const buf = new Uint8Array(await file.arrayBuffer());
        const uploadRes = await uploadImage.execute({
          cwd,
          filename: file.name || "pasted-image.png",
          mimeType: file.type || "image/png",
          bytes: buf,
        });
        if (!uploadRes.ok) throw uploadRes.error;
        return okResponse(uploadRes.value);
      }

      const body = (await request.json().catch(() => ({}))) as {
        filename?: string;
        mimeType?: string;
        dataBase64?: string;
        cwd?: string;
      };
      const base64 = (body.dataBase64 ?? "").replace(/^data:[^;]+;base64,/, "");
      const bytes = base64 ? Uint8Array.from(Buffer.from(base64, "base64")) : new Uint8Array(0);
      const uploadRes = await uploadImage.execute({
        cwd: body.cwd,
        filename: body.filename || "pasted-image.png",
        mimeType: body.mimeType || "image/png",
        bytes,
      });
      if (!uploadRes.ok) throw uploadRes.error;
      return okResponse(uploadRes.value);
    })
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
          if (session.pendingInteraction) {
            send({
              type: "interaction",
              interaction: session.pendingInteraction,
              status: "waiting_permission",
              timestamp: session.updatedAt,
            });
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
    .ws("/api/chat/sessions/:id/terminal", {
      open(ws) {
        const sessionId = ws.data.params.id;
        const session = sessions.get(sessionId);
        if (!session || session.controlMode !== "interactive" || !session.tmuxSession) {
          const errMsg: TerminalServerMessage = {
            type: "error",
            message: session
              ? "Session does not have an active interactive tmux session."
              : `Session not found: ${sessionId}`,
          };
          ws.send(JSON.stringify(errMsg));
          ws.close();
          return;
        }

        const tmuxSession = session.tmuxSession;
        const attachment = terminalAttach.attach(
          tmuxSession,
          (content) => {
            const msg: TerminalServerMessage = {
              type: "screen",
              content,
              tmuxSession,
              timestamp: new Date().toISOString(),
            };
            ws.send(JSON.stringify(msg));
          },
          (message) => {
            const msg: TerminalServerMessage = { type: "error", message };
            ws.send(JSON.stringify(msg));
          },
        );
        terminalAttachments.set(ws, attachment);
      },
      async message(ws, raw) {
        const attachment = terminalAttachments.get(ws);
        if (!attachment) return;

        let parsed: TerminalClientMessage | null = null;
        if (typeof raw === "string") {
          parsed = safeJsonParse<TerminalClientMessage>(raw);
        } else if (raw && typeof raw === "object") {
          parsed = raw as TerminalClientMessage;
        }
        if (!parsed) return;

        if (parsed.type === "key" && typeof parsed.key === "string") {
          await attachment.sendKey(parsed.key).catch(() => {});
        } else if (parsed.type === "text" && typeof parsed.text === "string") {
          await attachment.sendText(parsed.text).catch(() => {});
        }
      },
      close(ws) {
        const attachment = terminalAttachments.get(ws);
        if (attachment) {
          attachment.close();
          terminalAttachments.delete(ws);
        }
      },
    })
    .post(
      "/api/chat/send",
      async ({ body, set }) => {
        const result = await sendMessage.execute({
          prompt: body.prompt,
          sessionId: body.sessionId,
          model: body.model,
          cwd: body.cwd,
          authMode: body.authMode as AuthMode | undefined,
          agentProfile: body.agentProfile,
        });
        if (!result.ok) throw result.error;

        set.status = 202;
        return okResponse({
          session: toSessionInfo(result.value.session),
          isNewSession: result.value.isNewSession,
          concurrencyWarning: result.value.concurrencyWarning,
        });
      },
      {
        body: t.Object({
          prompt: t.String(),
          sessionId: t.Optional(t.String()),
          model: t.Optional(t.Union([t.Literal("sonnet"), t.Literal("opus"), t.Literal("haiku")])),
          cwd: t.Optional(t.String()),
          authMode: t.Optional(t.Union([t.Literal("machine_default"), t.Literal("api_key")])),
          agentProfile: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/api/chat/sessions/:id/resume",
      async ({ params, body }) => {
        const result = await resumeSession.execute({
          sessionId: params.id,
          model: body?.model,
          authMode: body?.authMode as AuthMode | undefined,
          agentProfile: body?.agentProfile,
        });
        if (!result.ok) throw result.error;
        return okResponse({
          session: toSessionInfo(result.value.session),
          concurrencyWarning: result.value.concurrencyWarning,
        });
      },
      {
        body: t.Optional(
          t.Object({
            model: t.Optional(
              t.Union([t.Literal("sonnet"), t.Literal("opus"), t.Literal("haiku")]),
            ),
            authMode: t.Optional(t.Union([t.Literal("machine_default"), t.Literal("api_key")])),
            agentProfile: t.Optional(t.String()),
          }),
        ),
      },
    )
    .post(
      "/api/chat/input",
      async ({ body }) => {
        const result = await sendInput.execute({
          sessionId: body.sessionId,
          interactionId: body.interactionId,
          inputType: body.inputType as ChatInputType,
          value: body.value as string | string[] | Record<string, string | string[]>,
        });
        if (!result.ok) throw result.error;
        return okResponse({
          session: toSessionInfo(result.value.session),
          method: result.value.method,
          resolved: result.value.resolved,
        });
      },
      {
        body: t.Object({
          sessionId: t.String(),
          interactionId: t.Optional(t.String()),
          inputType: t.Union([
            t.Literal("decision"),
            t.Literal("selection"),
            t.Literal("text"),
            t.Literal("key"),
          ]),
          value: t.Any(),
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
      const headerTmuxSession = request.headers.get("x-tmux-session") ?? undefined;
      const waitHeader = request.headers.get("x-harness-wait-decision");
      const waitForDecision = waitHeader === "1" || waitHeader === "true";

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
          typeof payload["tmux_session"] === "string"
            ? payload["tmux_session"]
            : headerTmuxSession,
        transcriptPath:
          typeof payload["transcript_path"] === "string" ? payload["transcript_path"] : undefined,
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : undefined,
        hookEventName,
        toolName: typeof payload["tool_name"] === "string" ? payload["tool_name"] : undefined,
        toolUseId: typeof payload["tool_use_id"] === "string" ? payload["tool_use_id"] : undefined,
        toolInput: payload["tool_input"],
        message: typeof payload["message"] === "string" ? payload["message"] : undefined,
        waitForDecision,
      });
      if (!result.ok) throw result.error;

      const hookOutput = buildHookOutput(result.value.decision);
      return okResponse({
        matched: result.value.matched,
        decision: result.value.decision,
        hookOutput,
      });
    });
}
