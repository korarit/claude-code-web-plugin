import type { AuthMode, ConcurrencyWarning, HarnessId, ModelId } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { newSessionId } from "@core/ids";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  attachExternalSession,
  attachTmuxSession,
  attachTranscript,
  createSession,
  markIdle,
  markRunning,
  recordPrompt,
  updateSessionModel,
  type Session,
} from "../domain/session.entity.ts";
import {
  ApiKeyNotConfiguredError,
  ChatBadRequestError,
  MirrorSessionError,
  SessionBusyError,
} from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type {
  AgentTelemetryPort,
  CanonicalSyncPort,
  EventBusPort,
  FileChangeTrackerPort,
  HarnessGatewayPort,
  PreparedSyncPrompt,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import { observeHarnessSessionWithSync, watchTranscriptWithSync } from "./transcript-sync.ts";

export interface SendMessageInput {
  prompt: string;
  sessionId?: string;
  harnessId?: HarnessId;
  model?: ModelId;
  cwd?: string;
  authMode?: AuthMode;
  agentProfile?: string;
}

export interface SendMessageOutput {
  session: Session;
  isNewSession: boolean;
  concurrencyWarning?: ConcurrencyWarning;
}

export interface SendMessageRuntime {
  port: number;
  token: string;
  defaultCwd: string;
  anthropicApiKey?: string;
  concurrencySoftLimit?: number;
  permissionHookTimeoutMs?: number;
}

function parseSlashModelCommand(prompt: string, harnessId: HarnessId): ModelId | null {
  if (harnessId === "claude") {
    const match = prompt.trim().match(/^\/model\s+(sonnet|opus|haiku)\s*$/i);
    return match ? match[1]!.toLowerCase() : null;
  }
  const match = prompt.trim().match(/^\/model\s+([^\s]+)\s*$/i);
  return match ? match[1]! : null;
}

export class SendMessageUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly runtime: SendMessageRuntime,
    private readonly clock: Clock = systemClock,
    private readonly coordinator?: InteractionCoordinator,
    private readonly fileChangeTracker?: FileChangeTrackerPort,
    private readonly agentTelemetry?: AgentTelemetryPort,
    private readonly harnessGateway?: HarnessGatewayPort,
    private readonly canonicalSync?: CanonicalSyncPort,
  ) {}

  async execute(input: SendMessageInput): Promise<Result<SendMessageOutput, AppError>> {
    const prompt = input.prompt?.trim();
    if (!prompt) return err(new ChatBadRequestError("prompt must not be empty"));
    if (prompt.length > 100_000) {
      return err(new ChatBadRequestError("prompt too long (max 100k chars)"));
    }

    const requestedId = input.sessionId?.trim();
    const existing = requestedId ? this.sessions.get(requestedId) : null;

    if (existing && existing.controlMode === "mirror") {
      return err(new MirrorSessionError(existing.id));
    }

    if (existing && (existing.status === "running" || existing.status === "waiting_permission")) {
      return err(new SessionBusyError(existing.id, existing.status));
    }

    const isNewSession = !existing;
    const harnessId: HarnessId = existing?.harnessId ?? input.harnessId ?? "claude";
    const slashModel = parseSlashModelCommand(prompt, harnessId);
    const defaultModel = this.harnessGateway?.getDefaultModel(harnessId) ?? "sonnet";
    const model: ModelId = slashModel ?? input.model?.trim() ?? existing?.model ?? defaultModel;
    const authMode: AuthMode = input.authMode ?? existing?.authMode ?? "machine_default";
    const agentProfile = input.agentProfile?.trim() || existing?.agentProfile;

    if (harnessId === "claude" && authMode === "api_key" && !this.runtime.anthropicApiKey) {
      return err(new ApiKeyNotConfiguredError());
    }

    const cwd = input.cwd?.trim() || existing?.cwd || this.runtime.defaultCwd;
    const sessionId = existing?.id ?? requestedId ?? newSessionId();

    const softLimit = this.runtime.concurrencySoftLimit ?? 3;
    const activeMachineDefault = this.sessions
      .list({ archived: false })
      .filter(
        (s) =>
          s.id !== sessionId &&
          (s.authMode ?? "machine_default") === "machine_default" &&
          (s.status === "running" || s.status === "waiting_permission"),
      ).length;

    const concurrencyWarning: ConcurrencyWarning | undefined =
      harnessId === "claude" && authMode === "machine_default" && activeMachineDefault + 1 > softLimit
        ? { activeCount: activeMachineDefault + 1, limit: softLimit }
        : undefined;

    let session: Session =
      existing ??
      createSession(
        {
          id: sessionId,
          model,
          harnessId,
          origin: "web",
          controlMode: "interactive",
          authMode,
          agentProfile,
          cwd,
        },
        this.clock,
      );

    let preparedSync: PreparedSyncPrompt | undefined;
    if (this.canonicalSync) {
      this.canonicalSync.ensureSession(session);
      preparedSync = await this.canonicalSync.preparePromptForSend(session, prompt, model);
    }

    const promptToSend = preparedSync?.promptToSend ?? prompt;
    const targetResumeId =
      preparedSync?.importedExternalSessionId ??
      (isNewSession
        ? undefined
        : (session.externalSessionId ?? (harnessId === "claude" ? session.id : undefined)));
    const targetTmuxName = preparedSync?.suggestedTmuxSessionName ?? session.tmuxSession;

    if (this.harnessGateway) {
      const started = await this.harnessGateway.startOrResumeSession(harnessId, {
        sessionId: session.id,
        model,
        cwd,
        port: this.runtime.port,
        token: this.runtime.token,
        resumeSessionId: targetResumeId,
        authMode,
        apiKey: authMode === "api_key" ? this.runtime.anthropicApiKey : undefined,
        agentProfile,
        tmuxSessionName: targetTmuxName,
      });

      if (started.externalSessionId) {
        session = attachExternalSession(session, started.externalSessionId, this.clock);
      } else if (preparedSync?.importedExternalSessionId) {
        session = attachExternalSession(session, preparedSync.importedExternalSessionId, this.clock);
      }
      if (started.tmuxSession) {
        session = attachTmuxSession(session, started.tmuxSession, this.clock);
      }
      if (started.transcriptPath) {
        session = attachTranscript(session, started.transcriptPath, this.clock);
      }
    } else {
      const ensured = await this.runner.ensureSession({
        sessionId: session.id,
        model,
        cwd,
        port: this.runtime.port,
        token: this.runtime.token,
        resumeSessionId: targetResumeId ?? (isNewSession ? undefined : session.id),
        authMode,
        apiKey: authMode === "api_key" ? this.runtime.anthropicApiKey : undefined,
        agentProfile,
        tmuxSessionName: targetTmuxName,
      });

      const transcriptPath =
        session.transcriptPath ?? this.watcher.resolveTranscriptPath(cwd, session.id);

      session = attachTmuxSession(session, ensured.tmuxSession, this.clock);
      session = attachTranscript(session, transcriptPath, this.clock);
    }

    if (slashModel) {
      session = updateSessionModel(session, slashModel, this.clock);
    }
    session = markRunning(session, this.clock, model);
    session = recordPrompt(session, prompt, this.clock);

    if (this.harnessGateway) {
      await observeHarnessSessionWithSync(session, {
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
    } else if (session.transcriptPath) {
      await watchTranscriptWithSync(session.id, session.transcriptPath, {
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

    let syncSummary = undefined;
    if (this.canonicalSync && preparedSync) {
      syncSummary = this.canonicalSync.commitPromptSent({
        prepared: preparedSync,
        model,
        externalSessionId: session.externalSessionId,
        tmuxSession: session.tmuxSession,
        transcriptPath: session.transcriptPath,
      });
    }

    this.sessions.save(session);
    this.eventBus.publishListEvent({ type: "upsert", session, syncSummary });

    const now = isoNow(this.clock);
    this.eventBus.publish(session.id, {
      type: "user",
      role: "user",
      text: prompt,
      harnessId: session.harnessId,
      model,
      syncedTurnsRange:
        preparedSync?.deltaFromSeq !== undefined && preparedSync?.deltaToSeq !== undefined
          ? { fromSeq: preparedSync.deltaFromSeq, toSeq: preparedSync.deltaToSeq }
          : undefined,
      syncStrategy: preparedSync?.strategy,
      syncFilePath: preparedSync?.syncFilePath,
      timestamp: now,
    });
    this.eventBus.publish(session.id, {
      type: "status",
      status: "running",
      timestamp: now,
    });

    try {
      if (this.harnessGateway) {
        await this.harnessGateway.sendPrompt(session, promptToSend, { model, agentProfile });
      } else {
        await this.runner.sendPrompt(session.tmuxSession!, promptToSend);
      }
    } catch (e) {
      const recovered = markIdle(session, this.clock);
      this.sessions.save(recovered);
      this.eventBus.publishListEvent({ type: "upsert", session: recovered });
      this.eventBus.publish(session.id, {
        type: "error",
        message: (e as Error).message,
        timestamp: isoNow(this.clock),
      });
      this.eventBus.publish(session.id, {
        type: "status",
        status: "idle",
        timestamp: isoNow(this.clock),
      });
      throw e;
    }

    return ok({ session, isNewSession, concurrencyWarning });
  }
}
