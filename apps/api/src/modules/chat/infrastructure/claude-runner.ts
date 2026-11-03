import type { ModelId } from "@contracts/chat";
import { safeJsonParse } from "@core/utils";
import type { DomainChatEvent, TokenUsage } from "../domain/chat.events.ts";
import { ClaudeSpawnError } from "../domain/errors.ts";
import type { RunnerPort, RunOptions } from "../application/ports.ts";

export function buildClaudeArgs(prompt: string, options: RunOptions): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--forward-subagent-text",
  ];
  if (options.model) args.push("--model", options.model satisfies ModelId);
  if (options.sessionId) args.push("--resume", options.sessionId);
  return args;
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      id?: string;
      parent_tool_use_id?: string | null;
    }>;
  };
  event?: { delta?: { type?: string; text?: string } };
  parent_tool_use_id?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  context_window?: number;
  total_cost_usd?: number;
  result?: string;
  error?: string;
}

/** Pure mapper: one NDJSON line from `claude -p --output-format stream-json` -> domain event. */
export function mapClaudeLine(raw: string, fallbackSessionId: string): DomainChatEvent | null {
  const line = safeJsonParse<ClaudeLine>(raw);
  if (!line || typeof line.type !== "string") return null;

  if (line.type === "system" && line.subtype === "init") {
    const usage: TokenUsage | undefined =
      line.context_window !== undefined ? { contextWindow: line.context_window } : undefined;
    return { type: "init", usage };
  }

  if (line.type === "stream_event" && line.event?.delta?.type === "text_delta") {
    const text = line.event.delta.text ?? "";
    return text ? { type: "delta", text, parentToolUseId: line.parent_tool_use_id ?? null } : null;
  }

  if (line.type === "assistant" || line.type === "user") {
    for (const block of line.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        return { type: "delta", text: block.text, parentToolUseId: line.parent_tool_use_id ?? null };
      }
      if (block.type === "tool_use" && block.name) {
        if (block.name === "Task" || block.name === "Skill") {
          return { type: "task", tool: block.name, parentToolUseId: block.id ?? null, text: block.name };
        }
        return { type: "tool", tool: block.name, parentToolUseId: line.parent_tool_use_id ?? null };
      }
    }
    return null;
  }

  if (line.type === "result") {
    if (line.error) return { type: "error", message: line.error };
    const usage: TokenUsage | undefined = line.usage
      ? { inputTokens: line.usage.input_tokens, outputTokens: line.usage.output_tokens }
      : undefined;
    return {
      type: "result",
      text: typeof line.result === "string" ? line.result : undefined,
      usage,
      costUsd: line.total_cost_usd,
    };
  }

  void fallbackSessionId;
  return null;
}

export class BunClaudeRunner implements RunnerPort {
  constructor(private readonly claudeBin = "claude") {}

  async *runStream(prompt: string, options: RunOptions): AsyncIterable<DomainChatEvent> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.claudeBin, ...buildClaudeArgs(prompt, options)], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: options.cwd,
        env: { ...process.env },
      });
    } catch (e) {
      throw new ClaudeSpawnError(`failed to spawn claude CLI: ${(e as Error).message}`);
    }

    const stdout = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!raw) continue;
          const event = mapClaudeLine(raw, options.sessionId ?? "");
          if (event) yield event;
        }
      }
      const rest = buf.trim();
      if (rest) {
        const event = mapClaudeLine(rest, options.sessionId ?? "");
        if (event) yield event;
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = proc.stderr as unknown as ReadableStream<Uint8Array> | undefined;
      const errText = stderr ? await new Response(stderr).text().catch(() => "") : "";
      yield {
        type: "error",
        message: errText.trim() || `claude CLI exited with code ${exitCode}`,
      };
    }
  }
}
