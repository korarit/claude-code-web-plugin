import type { ChatInputRequest, PermissionDecision, QuestionItem } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import { isoNow, systemClock, type Clock } from "@core/time";
import type { AppError } from "@core/errors";
import {
  ChatBadRequestError,
  MirrorSessionError,
  SessionNotFoundError,
  SessionNotRunningError,
} from "../domain/errors.ts";
import { clearPendingInteraction, markRunning, type Session } from "../domain/session.entity.ts";
import type { SessionRepository } from "../domain/repository.port.ts";
import type { InteractionCoordinator } from "./interaction-coordinator.ts";
import type { EventBusPort, TerminalRunnerPort } from "./ports.ts";

export interface SendInputOutput {
  session: Session;
  method: "hook" | "tmux";
  resolved: boolean;
}

const VALID_DECISIONS = new Set<PermissionDecision>(["allow_once", "always_allow", "deny"]);

const ALLOWED_KEYS = new Set([
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Space",
  "Tab",
  "BTab",
  "BSpace",
  "C-c",
  "C-d",
  "C-l",
  "y",
  "n",
  "1",
  "2",
  "3",
  "4",
  "5",
]);

export interface KeystrokeStep {
  keys?: string[];
  text?: string;
}

export function buildQuestionKeystrokes(
  questions: QuestionItem[],
  rawValue: ChatInputRequest["value"],
): KeystrokeStep[] {
  const steps: KeystrokeStep[] = [];
  const valueMap: Record<string, string | string[]> =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue
      : questions[0]
        ? { [questions[0].id]: rawValue as string | string[] }
        : {};

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const answer = valueMap[q.id];
    const selections = Array.isArray(answer) ? answer : answer ? [String(answer)] : [];

    if (q.multiSelect) {
      let cursor = 0;
      const matchedIndices = selections
        .map((sel) => q.options.findIndex((o) => o.id === sel || o.label === sel))
        .filter((idx) => idx >= 0)
        .sort((a, b) => a - b);

      for (const targetIdx of matchedIndices) {
        const delta = targetIdx - cursor;
        for (let i = 0; i < delta; i++) steps.push({ keys: ["Down"] });
        steps.push({ keys: ["Space"] });
        cursor = targetIdx;
      }

      const customAnswers = selections.filter(
        (sel) => !q.options.some((o) => o.id === sel || o.label === sel),
      );
      if (customAnswers.length > 0 && q.allowCustomText !== false) {
        const delta = q.options.length - cursor;
        for (let i = 0; i < delta; i++) steps.push({ keys: ["Down"] });
        steps.push({ keys: ["Enter"] });
        steps.push({ text: customAnswers.join(", ") });
      } else {
        steps.push({ keys: ["Enter"] });
      }
    } else {
      const first = selections[0] ?? "";
      const targetIdx = q.options.findIndex((o) => o.id === first || o.label === first);

      if (targetIdx >= 0) {
        const keys: string[] = [];
        for (let i = 0; i < targetIdx; i++) keys.push("Down");
        keys.push("Enter");
        steps.push({ keys });
      } else if (first && q.allowCustomText !== false) {
        // Custom text option is typically placed right after listed options ("Type something").
        const keys: string[] = [];
        for (let i = 0; i < q.options.length; i++) keys.push("Down");
        keys.push("Enter");
        steps.push({ keys });
        steps.push({ text: first });
      }
    }

    if (questions.length > 1 && qIdx === questions.length - 1) {
      // Multi-question wizard has a final Submit tab confirmation.
      steps.push({ keys: ["Enter"] });
    }
  }

  return steps;
}

export class SendInputUsecase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly runner: TerminalRunnerPort,
    private readonly eventBus: EventBusPort,
    private readonly coordinator: InteractionCoordinator,
    private readonly clock: Clock = systemClock,
  ) {}

  async execute(input: ChatInputRequest): Promise<Result<SendInputOutput, AppError>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return err(new SessionNotFoundError(input.sessionId));

    if (input.inputType === "decision") {
      const decision = String(input.value) as PermissionDecision;
      if (!VALID_DECISIONS.has(decision)) {
        return err(new ChatBadRequestError(`invalid permission decision: ${String(input.value)}`));
      }

      const hookResult = this.coordinator.resolvePermission(
        session.id,
        decision,
        input.interactionId,
      );

      if (hookResult.resolved) {
        let updated = clearPendingInteraction(session, this.clock);
        updated = markRunning(updated, this.clock);
        this.sessions.save(updated);
        this.eventBus.publishListEvent({ type: "upsert", session: updated });
        return ok({ session: updated, method: "hook", resolved: true });
      }

      if (session.controlMode === "mirror") {
        return err(new MirrorSessionError(session.id));
      }
      if (!session.tmuxSession) {
        return err(new SessionNotRunningError(session.id));
      }

      const fallbackKey =
        decision === "allow_once" ? "1" : decision === "always_allow" ? "2" : "3";
      await this.runner.sendRawKeys(session.tmuxSession, fallbackKey);

      let updated = clearPendingInteraction(session, this.clock);
      updated = markRunning(updated, this.clock);
      this.sessions.save(updated);
      this.eventBus.publishListEvent({ type: "upsert", session: updated });
      this.eventBus.publish(session.id, {
        type: "interaction_resolved",
        interactionId: input.interactionId ?? session.pendingInteraction?.id,
        timestamp: isoNow(this.clock),
      });
      this.eventBus.publish(session.id, {
        type: "status",
        status: "running",
        timestamp: isoNow(this.clock),
      });

      return ok({ session: updated, method: "tmux", resolved: true });
    }

    if (session.controlMode === "mirror") {
      return err(new MirrorSessionError(session.id));
    }
    if (!session.tmuxSession) {
      return err(new SessionNotRunningError(session.id));
    }

    if (input.inputType === "selection") {
      const pending = session.pendingInteraction ?? this.coordinator.getPending(session.id);
      if (pending && pending.kind === "question") {
        // Best-effort capture pane to confirm TUI is responsive before injecting keys.
        await this.runner.capturePane?.(session.tmuxSession, 40).catch(() => "");
        const steps = buildQuestionKeystrokes(pending.questions, input.value);
        for (const step of steps) {
          if (step.keys && step.keys.length > 0) {
            if (this.runner.sendKeysSequence) {
              await this.runner.sendKeysSequence(session.tmuxSession, step.keys);
            } else {
              for (const k of step.keys) {
                await this.runner.sendRawKeys(session.tmuxSession, k);
              }
            }
          }
          if (step.text) {
            await this.runner.sendPrompt(session.tmuxSession, step.text);
          }
        }
        return ok({ session, method: "tmux", resolved: false });
      }

      const fallbackText = Array.isArray(input.value)
        ? input.value.join(", ")
        : typeof input.value === "string"
          ? input.value
          : JSON.stringify(input.value);
      await this.runner.sendPrompt(session.tmuxSession, fallbackText);
      return ok({ session, method: "tmux", resolved: false });
    }

    if (input.inputType === "key") {
      const key = String(input.value).trim();
      if (!ALLOWED_KEYS.has(key)) {
        return err(new ChatBadRequestError(`unsupported key: ${key}`));
      }
      await this.runner.sendRawKeys(session.tmuxSession, key);
      return ok({ session, method: "tmux", resolved: false });
    }

    if (input.inputType === "text") {
      const text = String(input.value ?? "");
      if (!text.trim()) {
        return err(new ChatBadRequestError("input text must not be empty"));
      }
      await this.runner.sendPrompt(session.tmuxSession, text);
      return ok({ session, method: "tmux", resolved: false });
    }

    return err(new ChatBadRequestError(`unsupported inputType: ${String(input.inputType)}`));
  }
}
