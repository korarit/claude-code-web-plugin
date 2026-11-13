import { ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  attachTranscript,
  markIdle,
  markRunning,
  markStopped,
  markWaitingPermission,
  type Session,
} from "../domain/session.entity.ts";
import type { DomainHookEvent } from "../domain/chat.events.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { EventBusPort, TerminalRunnerPort, TranscriptWatcherPort } from "./ports.ts";

export interface HandleHookOutput {
  matched: boolean;
  session?: Session;
}

export class HandleHookUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly runner?: TerminalRunnerPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(hook: DomainHookEvent): Promise<Result<HandleHookOutput, AppError>> {
    const session = this.resolveSession(hook);
    if (!session) {
      return ok({ matched: false });
    }

    let next: Session = session;
    const timestamp = isoNow(this.clock);

    if (hook.transcriptPath && hook.transcriptPath !== next.transcriptPath) {
      next = attachTranscript(next, hook.transcriptPath, this.clock);
      await this.watcher.watch(next.id, hook.transcriptPath, (event) => {
        this.eventBus.publish(next.id, event);
      });
    }

    switch (hook.hookEventName) {
      case "SessionStart": {
        this.runner?.notifyReady?.(next.id);
        if (next.status === "stopped") {
          next = markIdle(next, this.clock);
          this.eventBus.publish(next.id, { type: "status", status: "idle", timestamp });
        }
        break;
      }
      case "UserPromptSubmit": {
        this.runner?.notifyReady?.(next.id);
        if (next.status !== "running") {
          next = markRunning(next, this.clock);
          this.eventBus.publish(next.id, { type: "status", status: "running", timestamp });
        }
        break;
      }
      case "PreToolUse":
      case "PostToolUse": {
        if (next.status !== "running") {
          next = markRunning(next, this.clock);
          this.eventBus.publish(next.id, { type: "status", status: "running", timestamp });
        }
        break;
      }
      case "PermissionRequest": {
        next = markWaitingPermission(next, this.clock);
        this.eventBus.publish(next.id, {
          type: "permission_prompt",
          status: "waiting_permission",
          permissionPrompt: {
            tool: hook.toolName,
            message:
              hook.message ??
              (hook.toolName
                ? `Waiting for approval to run ${hook.toolName}`
                : "Waiting for permission in Claude CLI"),
          },
          timestamp,
        });
        this.eventBus.publish(next.id, {
          type: "status",
          status: "waiting_permission",
          timestamp,
        });
        break;
      }
      case "Notification": {
        const msg = hook.message ?? "";
        if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("approval")) {
          next = markWaitingPermission(next, this.clock);
          this.eventBus.publish(next.id, {
            type: "permission_prompt",
            status: "waiting_permission",
            permissionPrompt: { tool: hook.toolName, message: msg },
            timestamp,
          });
          this.eventBus.publish(next.id, {
            type: "status",
            status: "waiting_permission",
            timestamp,
          });
        }
        break;
      }
      case "Stop": {
        next = markIdle(next, this.clock);
        this.eventBus.publish(next.id, { type: "status", status: "idle", timestamp });
        break;
      }
      case "SessionEnd": {
        next = markStopped(next, this.clock);
        this.eventBus.publish(next.id, { type: "status", status: "stopped", timestamp });
        this.watcher.unwatch(next.id);
        break;
      }
      default:
        break;
    }

    this.sessions.save(next);
    this.eventBus.publishListEvent({ type: "upsert", session: next });

    return ok({ matched: true, session: next });
  }

  private resolveSession(hook: DomainHookEvent): Session | null {
    if (hook.sessionId) {
      const byId = this.sessions.get(hook.sessionId);
      if (byId) return byId;
    }
    if (hook.externalSessionId) {
      const byExt =
        this.sessions.findByExternalSessionId(hook.externalSessionId) ??
        this.sessions.get(hook.externalSessionId);
      if (byExt) return byExt;
    }
    if (hook.transcriptPath) {
      const byPath = this.sessions.findByTranscriptPath(hook.transcriptPath);
      if (byPath) return byPath;
    }
    if (hook.tmuxSession) {
      const byTmux = this.sessions.findByTmuxSession(hook.tmuxSession);
      if (byTmux) return byTmux;
    }
    return null;
  }
}
