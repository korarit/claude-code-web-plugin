import type { ModelId } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { newSessionId } from "@core/ids";
import { systemClock, type Clock } from "@core/time";
import { createSession, touchSession, type Session } from "../domain/session.entity.ts";
import { ChatBadRequestError } from "../domain/errors.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { RunnerPort } from "./ports.ts";
import type { DomainChatEvent } from "../domain/chat.events.ts";

export interface SendMessageInput {
  prompt: string;
  sessionId?: string;
  model?: ModelId;
  cwd?: string;
}

export interface SendMessageOutput {
  session: Session;
  isNewSession: boolean;
  events: AsyncIterable<DomainChatEvent>;
}

export class SendMessageUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: RunnerPort,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: SendMessageInput): Promise<Result<SendMessageOutput, ChatBadRequestError>> {
    const prompt = input.prompt?.trim();
    if (!prompt) return err(new ChatBadRequestError("prompt must not be empty"));
    if (prompt.length > 100_000) return err(new ChatBadRequestError("prompt too long (max 100k chars)"));

    const model = input.model ?? "sonnet";
    let session = input.sessionId ? this.sessions.get(input.sessionId) : null;
    const isNewSession = !session;
    if (!session) {
      session = createSession(input.sessionId ?? newSessionId(), model, this.clock);
    }

    const current: Session = session;
    const events = this.runner.runStream(prompt, {
      sessionId: isNewSession ? undefined : current.id,
      model,
      cwd: input.cwd,
    });

    // Wrap the stream so the session is persisted once the run finishes.
    const self = this;
    async function* tracked(): AsyncIterable<DomainChatEvent> {
      try {
        yield* events;
      } finally {
        self.sessions.save(touchSession(current, model, self.clock));
      }
    }

    return ok({ session: current, isNewSession, events: tracked() });
  }
}
