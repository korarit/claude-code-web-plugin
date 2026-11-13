import type { ModelId } from "@contracts/chat";
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
  type Session,
} from "../domain/session.entity.ts";
import { ChatBadRequestError, SessionBusyError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { EventBusPort, TerminalRunnerPort, TranscriptWatcherPort } from "./ports.ts";

export interface SendMessageInput {
  prompt: string;
  sessionId?: string;
  model?: ModelId;
  cwd?: string;
}

export interface SendMessageOutput {
  session: Session;
  isNewSession: boolean;
}

export interface SendMessageRuntime {
  port: number;
  token: string;
  defaultCwd: string;
}

export class SendMessageUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly watcher: TranscriptWatcherPort,
    private readonly eventBus: EventBusPort,
    private readonly runtime: SendMessageRuntime,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: SendMessageInput): Promise<Result<SendMessageOutput, AppError>> {
    const prompt = input.prompt?.trim();
    if (!prompt) return err(new ChatBadRequestError("prompt must not be empty"));
    if (prompt.length > 100_000) {
      return err(new ChatBadRequestError("prompt too long (max 100k chars)"));
    }

    const requestedId = input.sessionId?.trim();
    let existing = requestedId ? this.sessions.get(requestedId) : null;

    if (existing && (existing.status === "running" || existing.status === "waiting_permission")) {
      return err(new SessionBusyError(existing.id, existing.status));
    }

    const isNewSession = !existing;
    const model: ModelId = input.model ?? existing?.model ?? "sonnet";
    const cwd = input.cwd?.trim() || existing?.cwd || this.runtime.defaultCwd;
    const sessionId = existing?.id ?? requestedId ?? newSessionId();

    let session: Session =
      existing ??
      createSession(
        {
          id: sessionId,
          model,
          harnessId: "claude",
          origin: "web",
          controlMode: "interactive",
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
    });

    const transcriptPath =
      session.transcriptPath ?? this.watcher.resolveTranscriptPath(cwd, session.id);

    session = attachTmuxSession(session, ensured.tmuxSession, this.clock);
    session = attachTranscript(session, transcriptPath, this.clock);
    session = markRunning(session, this.clock, model);
    session = recordPrompt(session, prompt, this.clock);

    this.sessions.save(session);
    this.eventBus.publishListEvent({ type: "upsert", session });

    await this.watcher.watch(session.id, transcriptPath, (event) => {
      this.eventBus.publish(session.id, event);
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

    return ok({ session, isNewSession });
  }
}
