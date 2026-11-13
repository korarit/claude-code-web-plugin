import type { AuthMode, ConcurrencyWarning, ModelId } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { newSessionId } from "@core/ids";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
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
  EventBusPort,
  FileChangeTrackerPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./ports.ts";
import { watchTranscriptWithSync } from "./transcript-sync.ts";

export interface SendMessageInput {
  prompt: string;
  sessionId?: string;
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

function parseSlashModelCommand(prompt: string): ModelId | null {
  const match = prompt.trim().match(/^\/model\s+(sonnet|opus|haiku)\s*$/i);
  return match ? (match[1]!.toLowerCase() as ModelId) : null;
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
    const slashModel = parseSlashModelCommand(prompt);
    const model: ModelId = slashModel ?? input.model ?? existing?.model ?? "sonnet";
    const authMode: AuthMode = input.authMode ?? existing?.authMode ?? "machine_default";
    const agentProfile = input.agentProfile?.trim() || existing?.agentProfile;

    if (authMode === "api_key" && !this.runtime.anthropicApiKey) {
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
      authMode === "machine_default" && activeMachineDefault + 1 > softLimit
        ? { activeCount: activeMachineDefault + 1, limit: softLimit }
        : undefined;

    let session: Session =
      existing ??
      createSession(
        {
          id: sessionId,
          model,
          harnessId: "claude",
          origin: "web",
          controlMode: "interactive",
          authMode,
          agentProfile,
          cwd,
        },
        this.clock,
      );

    const ensured = await this.runner.ensureSession({
      sessionId: session.id,
      model,
      cwd,
      port: this.runtime.port,
      token: this.runtime.token,
      resumeSessionId: isNewSession ? undefined : (session.externalSessionId ?? session.id),
      authMode,
      apiKey: authMode === "api_key" ? this.runtime.anthropicApiKey : undefined,
      agentProfile,
      tmuxSessionName: session.tmuxSession,
    });

    const transcriptPath =
      session.transcriptPath ?? this.watcher.resolveTranscriptPath(cwd, session.id);

    session = attachTmuxSession(session, ensured.tmuxSession, this.clock);
    session = attachTranscript(session, transcriptPath, this.clock);
    if (slashModel) {
      session = updateSessionModel(session, slashModel, this.clock);
    }
    session = markRunning(session, this.clock, model);
    session = recordPrompt(session, prompt, this.clock);

    this.sessions.save(session);
    this.eventBus.publishListEvent({ type: "upsert", session });

    await watchTranscriptWithSync(session.id, transcriptPath, {
      sessions: this.sessions,
      watcher: this.watcher,
      eventBus: this.eventBus,
      coordinator: this.coordinator,
      fileChangeTracker: this.fileChangeTracker,
      clock: this.clock,
    });

    const now = isoNow(this.clock);
    this.eventBus.publish(session.id, {
      type: "user",
      role: "user",
      text: prompt,
      timestamp: now,
    });
    this.eventBus.publish(session.id, {
      type: "status",
      status: "running",
      timestamp: now,
    });

    try {
      await this.runner.sendPrompt(ensured.tmuxSession, prompt);
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
