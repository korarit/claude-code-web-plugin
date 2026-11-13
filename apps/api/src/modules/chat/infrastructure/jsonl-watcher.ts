import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PendingInteraction, QuestionItem } from "@contracts/chat";
import { newInteractionId } from "@core/ids";
import { safeJsonParse, truncate } from "@core/utils";
import type { DomainChatEvent, TokenUsage } from "../domain/chat.events.ts";
import type { TranscriptWatcherPort } from "../application/ports.ts";

export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function buildClaudeTranscriptPath(
  claudeHome: string,
  cwd: string,
  sessionId: string,
): string {
  return join(claudeHome, "projects", encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  parentToolUseId?: string | null;
  parent_tool_use_id?: string | null;
  context_window?: number;
  costUSD?: number;
  total_cost_usd?: number;
  result?: string;
  error?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  data?: {
    type?: string;
    message?: string;
    toolName?: string;
  };
}

function inferContextWindow(model?: string): number {
  if (!model) return 200_000;
  if (model.includes("1m") || model.includes("[1m]")) return 1_000_000;
  return 200_000;
}

function formatToolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const obj = input as Record<string, unknown>;
  const target =
    obj["file_path"] ?? obj["path"] ?? obj["command"] ?? obj["pattern"] ?? obj["description"];
  if (typeof target === "string" && target.trim()) {
    return `${name}: ${truncate(target.trim(), 100)}`;
  }
  return name;
}

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return truncate(content, 200);
  if (Array.isArray(content)) {
    const firstText = content.find(
      (c): c is { text: string } =>
        Boolean(c) && typeof c === "object" && typeof (c as { text?: unknown }).text === "string",
    );
    if (firstText) return truncate(firstText.text, 200);
  }
  return undefined;
}

function parseAskUserQuestionInteraction(
  toolUseId: string | undefined,
  input: unknown,
  timestamp?: string,
): PendingInteraction | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const rawQuestions = Array.isArray(obj["questions"])
    ? obj["questions"]
    : typeof obj["question"] === "string"
      ? [obj]
      : [];

  const questions: QuestionItem[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    if (!q || typeof q !== "object") continue;
    const qObj = q as Record<string, unknown>;
    const prompt = typeof qObj["question"] === "string" ? qObj["question"] : "";
    if (!prompt) continue;

    const rawOptions = Array.isArray(qObj["options"]) ? qObj["options"] : [];
    const options = rawOptions
      .map((opt, idx) => {
        if (typeof opt === "string") {
          return { id: String(idx), label: opt };
        }
        if (opt && typeof opt === "object") {
          const o = opt as Record<string, unknown>;
          const label = typeof o["label"] === "string" ? o["label"] : String(o["id"] ?? idx);
          const description = typeof o["description"] === "string" ? o["description"] : undefined;
          return { id: label, label, description };
        }
        return null;
      })
      .filter((item): item is { id: string; label: string; description?: string } => item !== null);

    questions.push({
      id: typeof qObj["header"] === "string" && qObj["header"] ? qObj["header"] : `q-${i}`,
      header: typeof qObj["header"] === "string" ? qObj["header"] : undefined,
      prompt,
      multiSelect: Boolean(qObj["multiSelect"]),
      options,
      allowCustomText: true,
    });
  }

  if (questions.length === 0) return null;

  return {
    id: toolUseId ?? newInteractionId(),
    sessionId: "",
    kind: "question",
    toolUseId,
    questions,
    createdAt: timestamp ?? new Date().toISOString(),
  };
}

export function parseClaudeTranscriptLine(raw: string): DomainChatEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const line = safeJsonParse<TranscriptLine>(trimmed);
  if (!line || typeof line.type !== "string") return [];

  const timestamp = line.timestamp;
  const parentToolUseId = line.parentToolUseId ?? line.parent_tool_use_id ?? null;
  const events: DomainChatEvent[] = [];

  if (line.type === "system") {
    if (line.subtype === "init" || line.context_window !== undefined) {
      events.push({
        id: line.uuid,
        type: "init",
        usage:
          line.context_window !== undefined ? { contextWindow: line.context_window } : undefined,
        timestamp,
      });
    }
    return events;
  }

  if (line.type === "user") {
    if (line.isMeta) return [];
    const content = line.message?.content;
    if (typeof content === "string") {
      if (content.trim()) {
        events.push({
          id: line.uuid,
          type: "user",
          role: "user",
          text: content,
          parentToolUseId,
          timestamp,
        });
      }
      return events;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          events.push({
            id: line.uuid,
            type: "user",
            role: "user",
            text: block.text,
            parentToolUseId,
            timestamp,
          });
        } else if (block.type === "tool_result") {
          events.push({
            id: line.uuid,
            type: "tool",
            tool: "tool_result",
            toolUseId: block.tool_use_id,
            text: extractToolResultText(block.content),
            parentToolUseId,
            timestamp,
          });
          if (block.tool_use_id) {
            events.push({
              id: `resolved-${block.tool_use_id}`,
              type: "interaction_resolved",
              toolUseId: block.tool_use_id,
              interactionId: block.tool_use_id,
              timestamp,
            });
          }
        }
      }
    }
    return events;
  }

  if (line.type === "assistant") {
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          events.push({
            id: line.uuid,
            type: "delta",
            role: "assistant",
            text: block.text,
            parentToolUseId,
            timestamp,
          });
        } else if (block.type === "tool_use" && block.name) {
          const isTask = block.name === "Task" || block.name === "Agent" || block.name === "Skill";
          events.push({
            id: block.id ?? line.uuid,
            type: isTask ? "task" : "tool",
            tool: block.name,
            toolUseId: block.id,
            toolInput: block.input,
            text: formatToolSummary(block.name, block.input),
            parentToolUseId: isTask ? (block.id ?? parentToolUseId) : parentToolUseId,
            timestamp,
          });
          if (block.name === "AskUserQuestion") {
            const interaction = parseAskUserQuestionInteraction(block.id, block.input, timestamp);
            if (interaction) {
              events.push({
                id: `interaction-${interaction.id}`,
                type: "interaction",
                toolUseId: block.id,
                interaction,
                timestamp,
              });
            }
          }
        }
      }
    }

    const u = line.message?.usage;
    if (u) {
      const inputTokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      const usage: TokenUsage = {
        inputTokens,
        outputTokens: u.output_tokens ?? 0,
        contextWindow: inferContextWindow(line.message?.model),
      };
      events.push({
        type: "result",
        usage,
        costUsd: line.costUSD ?? line.total_cost_usd,
        timestamp,
      });
    }
    return events;
  }

  if (line.type === "progress" && parentToolUseId) {
    if (line.data?.toolName) {
      events.push({
        id: line.uuid,
        type: "task",
        tool: line.data.toolName,
        text: line.data.message ?? line.data.toolName,
        parentToolUseId,
        timestamp,
      });
    }
    return events;
  }

  if (line.type === "result") {
    if (line.error) {
      events.push({ type: "error", message: line.error, timestamp });
      return events;
    }
    events.push({
      type: "result",
      text: typeof line.result === "string" ? line.result : undefined,
      costUsd: line.total_cost_usd ?? line.costUSD,
      timestamp,
    });
  }

  return events;
}

interface WatchState {
  sessionId: string;
  transcriptPath: string;
  byteOffset: number;
  remainder: string;
  onEvent: (event: DomainChatEvent) => void;
  fsWatcher?: FSWatcher;
  dirWatcher?: FSWatcher;
  pollTimer?: ReturnType<typeof setInterval>;
  reading: boolean;
}

export class JsonlTranscriptWatcher implements TranscriptWatcherPort {
  private readonly watchers = new Map<string, WatchState>();

  constructor(private readonly claudeHome: string) {}

  resolveTranscriptPath(cwd: string, sessionId: string): string {
    return buildClaudeTranscriptPath(this.claudeHome, cwd, sessionId);
  }

  async watch(
    sessionId: string,
    transcriptPath: string,
    onEvent: (event: DomainChatEvent) => void,
  ): Promise<void> {
    const existing = this.watchers.get(sessionId);
    if (existing && existing.transcriptPath === transcriptPath) {
      existing.onEvent = onEvent;
      return;
    }
    if (existing) {
      this.unwatch(sessionId);
    }

    let initialOffset = 0;
    if (existsSync(transcriptPath)) {
      try {
        initialOffset = statSync(transcriptPath).size;
      } catch {
        initialOffset = 0;
      }
    }

    const state: WatchState = {
      sessionId,
      transcriptPath,
      byteOffset: initialOffset,
      remainder: "",
      onEvent,
      reading: false,
    };
    this.watchers.set(sessionId, state);

    this.attachWatchers(state);
    state.pollTimer = setInterval(() => {
      void this.flushNewBytes(state);
    }, 350);
  }

  unwatch(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;
    state.fsWatcher?.close();
    state.dirWatcher?.close();
    if (state.pollTimer) clearInterval(state.pollTimer);
    this.watchers.delete(sessionId);
  }

  async readRecentEvents(transcriptPath: string, limit = 500): Promise<DomainChatEvent[]> {
    if (!existsSync(transcriptPath)) return [];
    const content = await readFile(transcriptPath, "utf8");
    const lines = content.split("\n");
    const events: DomainChatEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(...parseClaudeTranscriptLine(line));
    }
    if (events.length > limit) {
      return events.slice(events.length - limit);
    }
    return events;
  }

  async flushSession(sessionId: string): Promise<void> {
    const state = this.watchers.get(sessionId);
    if (state) await this.flushNewBytes(state);
  }

  private attachWatchers(state: WatchState): void {
    if (existsSync(state.transcriptPath)) {
      if (!state.fsWatcher) {
        try {
          state.fsWatcher = watch(state.transcriptPath, () => {
            void this.flushNewBytes(state);
          });
        } catch {
          // Fallback pollTimer remains active.
        }
      }
      return;
    }

    const dir = dirname(state.transcriptPath);
    if (existsSync(dir) && !state.dirWatcher) {
      try {
        state.dirWatcher = watch(dir, (_eventType, filename) => {
          if (!filename || state.transcriptPath.endsWith(String(filename))) {
            if (existsSync(state.transcriptPath)) {
              state.dirWatcher?.close();
              state.dirWatcher = undefined;
              this.attachWatchers(state);
              void this.flushNewBytes(state);
            }
          }
        });
      } catch {
        // Fallback pollTimer remains active.
      }
    }
  }

  private async flushNewBytes(state: WatchState): Promise<void> {
    if (state.reading) return;
    if (!existsSync(state.transcriptPath)) return;

    if (!state.fsWatcher) {
      this.attachWatchers(state);
    }

    state.reading = true;
    try {
      const size = statSync(state.transcriptPath).size;
      if (size < state.byteOffset) {
        state.byteOffset = 0;
        state.remainder = "";
      }
      if (size === state.byteOffset) return;

      const deltaLen = size - state.byteOffset;
      const handle = await open(state.transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(deltaLen);
        const { bytesRead } = await handle.read(buffer, 0, deltaLen, state.byteOffset);
        state.byteOffset += bytesRead;
        const chunk = state.remainder + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = chunk.split("\n");
        state.remainder = lines.pop() ?? "";

        for (const line of lines) {
          for (const event of parseClaudeTranscriptLine(line)) {
            state.onEvent(event);
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Transient read error; next poll/fs event will retry.
    } finally {
      state.reading = false;
    }
  }
}
