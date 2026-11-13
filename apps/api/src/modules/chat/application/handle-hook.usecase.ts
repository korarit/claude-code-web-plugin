import type { PendingInteraction, PermissionDecision } from "@contracts/chat";
import { newInteractionId, newSessionId } from "@core/ids";
import { ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  attachTranscript,
  clearPendingInteraction,
  createSession,
  markIdle,
  markRunning,
  markStopped,
  setPendingInteraction,
  type Session,
} from "../domain/session.entity.ts";
import type { DomainHookEvent } from "../domain/chat.events.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  CanonicalSyncPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import { observeHarnessSessionWithSync, watchTranscriptWithSync } from "./transcript-sync.ts";

export interface HandleHookOutput {
  matched: boolean;
  session?: Session;
  decision?: PermissionDecision | "timeout";
}

function extractCommandOrTarget(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const obj = toolInput as Record<string, unknown>;
  const candidate =
    obj["CommandLine"] ??
    obj["command"] ??
    obj["TargetFile"] ??
    obj["file_path"] ??
    obj["filePath"] ??
    obj["Path"] ??
    obj["path"] ??
    obj["Url"] ??
    obj["url"] ??
    obj["Query"] ??
    obj["Pattern"] ??
    obj["pattern"];
  if (typeof candidate !== "string") return undefined;
  const cleaned = candidate.trim().replace(/^"|"$/g, "");
  return cleaned || undefined;
}

export class HandleHookUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly runner?: TerminalRunnerPort,
    private readonly clock: Clock = systemClock,
    private readonly coordinator?: InteractionCoordinator,
    private readonly permissionTimeoutMs = 55_000,
    private readonly fileChangeTracker?: FileChangeTrackerPort,
    private readonly agentTelemetry?: AgentTelemetryPort,
    private readonly harnessGateway?: HarnessGatewayPort,
    private readonly canonicalSync?: CanonicalSyncPort,
  ) {}

  async execute(hook: DomainHookEvent): Promise<Result<HandleHookOutput, AppError>> {
    let session = this.resolveSession(hook);
    if (!session) {
      session = this.autoDiscoverSession(hook);
      if (!session) {
        return ok({ matched: false });
      }
    }

    let next: Session = session;
    const timestamp = isoNow(this.clock);

    if (hook.transcriptPath && hook.transcriptPath !== next.transcriptPath) {
      next = attachTranscript(next, hook.transcriptPath, this.clock);
    }

    if (this.harnessGateway) {
      await observeHarnessSessionWithSync(next, {
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
    } else if (next.transcriptPath) {
      await watchTranscriptWithSync(next.id, next.transcriptPath, {
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
      case "PreToolUse": {
        if (this.fileChangeTracker && hook.toolName && (hook.cwd || next.cwd)) {
          await this.fileChangeTracker
            .onPreToolUse({
              sessionId: next.id,
              cwd: hook.cwd || next.cwd!,
              harnessId: next.harnessId,
              model: next.model,
              toolName: hook.toolName,
              toolUseId: hook.toolUseId,
              toolInput: hook.toolInput,
              agentId: hook.agentId,
            })
            .catch(() => {});
        }
        if (this.coordinator && hook.waitForDecision) {
          const commandOrTarget = extractCommandOrTarget(hook.toolInput);
          const message =
            hook.message ??
            (hook.toolName
              ? `Waiting for approval to run ${hook.toolName}`
              : `Waiting for permission in ${next.harnessId}`);
          const interaction: PendingInteraction = {
            id: newInteractionId(),
            sessionId: next.id,
            kind: "permission",
            toolName: hook.toolName ?? "Tool",
            commandOrTarget,
            message,
            options: [
              { id: "allow_once", label: "Allow Once" },
              { id: "always_allow", label: "Always Allow" },
              { id: "deny", label: "Deny" },
            ],
            createdAt: timestamp,
          };
          next = setPendingInteraction(next, interaction, this.clock);
          this.sessions.save(next);
          this.eventBus.publishListEvent({ type: "upsert", session: next });
          this.eventBus.publish(next.id, {
            type: "interaction",
            interaction,
            status: "waiting_permission",
            timestamp,
          });
          this.eventBus.publish(next.id, {
            type: "permission_prompt",
            status: "waiting_permission",
            permissionPrompt: {
              tool: hook.toolName,
              command: commandOrTarget,
              message,
            },
            timestamp,
          });
          this.eventBus.publish(next.id, {
            type: "status",
            status: "waiting_permission",
            timestamp,
          });
          if (this.agentTelemetry) {
            await this.agentTelemetry
              .onHookEvent(next.id, { ...hook, hookEventName: "PermissionRequest" }, next.externalSessionId)
              .catch(() => {});
          }
          const decision = await this.coordinator.waitForPermissionDecision(
            next.id,
            interaction,
            this.permissionTimeoutMs,
          );
          const latest = this.sessions.get(next.id) ?? next;
          if (decision !== "timeout") {
            let resumed = clearPendingInteraction(latest, this.clock);
            resumed = markRunning(resumed, this.clock);
            this.sessions.save(resumed);
            this.eventBus.publishListEvent({ type: "upsert", session: resumed });
            this.eventBus.publish(resumed.id, {
              type: "interaction_resolved",
              interactionId: interaction.id,
              timestamp: isoNow(this.clock),
            });
            this.eventBus.publish(resumed.id, {
              type: "status",
              status: "running",
              timestamp: isoNow(this.clock),
            });
            if (this.agentTelemetry) {
              await this.agentTelemetry
                .onHookEvent(
                  resumed.id,
                  { ...hook, hookEventName: "PermissionResolved" },
                  resumed.externalSessionId,
                )
                .catch(() => {});
            }
            return ok({ matched: true, session: resumed, decision });
          }
          return ok({ matched: true, session: latest, decision: "timeout" });
        }
        if (next.status !== "running") {
          next = markRunning(next, this.clock);
          this.eventBus.publish(next.id, { type: "status", status: "running", timestamp });
        }
        break;
      }
      case "PostToolUse": {
        if (this.fileChangeTracker && hook.toolName && (hook.cwd || next.cwd)) {
          await this.fileChangeTracker
            .onPostToolUse({
              sessionId: next.id,
              cwd: hook.cwd || next.cwd!,
              harnessId: next.harnessId,
              model: next.model,
              toolName: hook.toolName,
              toolUseId: hook.toolUseId,
              toolInput: hook.toolInput,
              agentId: hook.agentId,
              editedAt: timestamp,
            })
            .catch(() => {});
        }
        const prevPendingId = next.pendingInteraction?.id;
        const cleared = this.coordinator?.clearPending(next.id);
        if (next.pendingInteraction) {
          next = clearPendingInteraction(next, this.clock);
          this.eventBus.publish(next.id, {
            type: "interaction_resolved",
            interactionId: cleared?.id ?? prevPendingId,
            timestamp,
          });
        }
        if (next.status !== "running") {
          next = markRunning(next, this.clock);
          this.eventBus.publish(next.id, { type: "status", status: "running", timestamp });
        }
        break;
      }
      case "PermissionRequest": {
        const commandOrTarget = extractCommandOrTarget(hook.toolInput);
        const message =
          hook.message ??
          (hook.toolName
            ? `Waiting for approval to run ${hook.toolName}`
            : "Waiting for permission in Claude CLI");

        const interaction: PendingInteraction = {
          id: newInteractionId(),
          sessionId: next.id,
          kind: "permission",
          toolName: hook.toolName ?? "Tool",
          commandOrTarget,
          message,
          options: [
            { id: "allow_once", label: "Allow Once" },
            { id: "always_allow", label: "Always Allow" },
            { id: "deny", label: "Deny" },
          ],
          createdAt: timestamp,
        };

        next = setPendingInteraction(next, interaction, this.clock);
        this.sessions.save(next);
        this.eventBus.publishListEvent({ type: "upsert", session: next });

        this.eventBus.publish(next.id, {
          type: "interaction",
          interaction,
          status: "waiting_permission",
          timestamp,
        });
        this.eventBus.publish(next.id, {
          type: "permission_prompt",
          status: "waiting_permission",
          permissionPrompt: {
            tool: hook.toolName,
            command: commandOrTarget,
            message,
          },
          timestamp,
        });
        this.eventBus.publish(next.id, {
          type: "status",
          status: "waiting_permission",
          timestamp,
        });

        if (this.coordinator && hook.waitForDecision) {
          this.sessions.save(next);
          this.eventBus.publishListEvent({ type: "upsert", session: next });
          if (this.agentTelemetry) {
            await this.agentTelemetry
              .onHookEvent(next.id, hook, next.externalSessionId)
              .catch(() => {});
          }
          const decision = await this.coordinator.waitForPermissionDecision(
            next.id,
            interaction,
            this.permissionTimeoutMs,
          );
          const latest = this.sessions.get(next.id) ?? next;
          if (decision !== "timeout") {
            let resumed = clearPendingInteraction(latest, this.clock);
            resumed = markRunning(resumed, this.clock);
            this.sessions.save(resumed);
            this.eventBus.publishListEvent({ type: "upsert", session: resumed });
            this.eventBus.publish(resumed.id, {
              type: "interaction_resolved",
              interactionId: interaction.id,
              timestamp: isoNow(this.clock),
            });
            this.eventBus.publish(resumed.id, {
              type: "status",
              status: "running",
              timestamp: isoNow(this.clock),
            });
            if (this.agentTelemetry) {
              await this.agentTelemetry
                .onHookEvent(
                  resumed.id,
                  { ...hook, hookEventName: "PermissionResolved" },
                  resumed.externalSessionId,
                )
                .catch(() => {});
            }
            return ok({ matched: true, session: resumed, decision });
          }
          return ok({ matched: true, session: latest, decision: "timeout" });
        }
        break;
      }
      case "Notification": {
        const msg = hook.message ?? "";
        if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("approval")) {
          const interaction: PendingInteraction = {
            id: newInteractionId(),
            sessionId: next.id,
            kind: "permission",
            toolName: hook.toolName ?? "Tool",
            commandOrTarget: extractCommandOrTarget(hook.toolInput),
            message: msg,
            options: [
              { id: "allow_once", label: "Allow Once" },
              { id: "always_allow", label: "Always Allow" },
              { id: "deny", label: "Deny" },
            ],
            createdAt: timestamp,
          };
          this.coordinator?.setPending(next.id, interaction);
          next = setPendingInteraction(next, interaction, this.clock);
          this.eventBus.publish(next.id, {
            type: "interaction",
            interaction,
            status: "waiting_permission",
            timestamp,
          });
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
        const prevPendingId = next.pendingInteraction?.id;
        const cleared = this.coordinator?.clearPending(next.id);
        this.coordinator?.cancelSession(next.id);
        if (next.pendingInteraction) {
          next = clearPendingInteraction(next, this.clock);
          this.eventBus.publish(next.id, {
            type: "interaction_resolved",
            interactionId: cleared?.id ?? prevPendingId,
            timestamp,
          });
        }
        next = markIdle(next, this.clock);
        this.eventBus.publish(next.id, { type: "status", status: "idle", timestamp });
        break;
      }
      case "SessionEnd": {
        this.coordinator?.cancelSession(next.id);
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

    if (this.agentTelemetry) {
      await this.agentTelemetry
        .onHookEvent(next.id, hook, next.externalSessionId)
        .catch(() => {});
    }

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

  private autoDiscoverSession(hook: DomainHookEvent): Session | null {
    if (!hook.externalSessionId && !hook.transcriptPath) return null;

    const inferredHarness =
      hook.harnessId ??
      (hook.transcriptPath?.includes("antigravity") ? "agy" : "claude");
    const isTmux = Boolean(hook.tmuxSession && !hook.tmuxSession.startsWith("cw-"));
    const session = createSession(
      {
        id: newSessionId(),
        model: inferredHarness === "agy" ? "gemini-2.5-pro" : "sonnet",
        harnessId: inferredHarness,
        origin: isTmux ? "tmux" : "cli",
        controlMode: isTmux ? "interactive" : "mirror",
        status: hook.hookEventName === "Stop" ? "idle" : "running",
        externalSessionId: hook.externalSessionId,
        discoveredAt: isoNow(this.clock),
        tmuxSession: isTmux ? hook.tmuxSession : undefined,
        transcriptPath: hook.transcriptPath,
        cwd: hook.cwd,
      },
      this.clock,
    );

    this.sessions.save(session);
    this.canonicalSync?.ensureSession(session);
    this.eventBus.publishListEvent({ type: "upsert", session });
    return session;
  }
}
