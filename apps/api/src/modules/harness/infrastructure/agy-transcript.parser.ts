import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingInteraction, QuestionItem } from "@contracts/chat";
import { newInteractionId } from "@core/ids";
import { safeJsonParse, truncate } from "@core/utils";
import type { NormalizedHarnessEvent } from "../domain/harness.port.ts";

interface AgyToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface AgyTranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  model?: string;
  cwd?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  tool_calls?: AgyToolCall[];
}

export function extractAgyUserText(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const body = match ? match[1]! : raw;
  return body.trim();
}

export function extractAgyCwdFromContent(raw: string): string | undefined {
  const match = raw.match(/Active Workspaces:\s*\n\s*-\s*([^\n\r]+)/);
  if (match?.[1]?.trim()) return match[1].trim();
  const cmdMatch = raw.match(/Command Working Directory:\s*([^\n\r]+)/);
  if (cmdMatch?.[1]?.trim()) return cmdMatch[1].trim();
  return undefined;
}

function formatAgyToolSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const obj = args as Record<string, unknown>;
  const rawTarget =
    obj["TargetFile"] ??
    obj["Path"] ??
    obj["file_path"] ??
    obj["path"] ??
    obj["CommandLine"] ??
    obj["command"] ??
    obj["Query"] ??
    obj["Pattern"] ??
    obj["Role"] ??
    obj["Description"];
  if (typeof rawTarget === "string" && rawTarget.trim()) {
    return `${name}: ${truncate(rawTarget.trim().replace(/^"|"$/g, ""), 100)}`;
  }
  return name;
}

function normalizeAgyToolArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const obj = args as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      normalized[k] = v.slice(1, -1);
    }
  }
  return normalized;
}

function parseAgyQuestionInteraction(
  toolUseId: string | undefined,
  args: unknown,
  timestamp?: string,
): PendingInteraction | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const rawQuestions = Array.isArray(obj["questions"]) ? obj["questions"] : [];
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
        if (typeof opt === "string") return { id: opt, label: opt };
        if (opt && typeof opt === "object") {
          const o = opt as Record<string, unknown>;
          const label = typeof o["label"] === "string" ? o["label"] : String(o["id"] ?? idx);
          return {
            id: label,
            label,
            description: typeof o["description"] === "string" ? o["description"] : undefined,
          };
        }
        return null;
      })
      .filter((x): x is { id: string; label: string; description?: string } => x !== null);
    questions.push({
      id: `q-${i}`,
      prompt,
      multiSelect: Boolean(qObj["is_multi_select"]),
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

export interface AgyParseState {
  pendingToolIds: string[];
  pendingSubagents: Array<{ toolUseId: string; role: string; agentType?: string }>;
  brainBaseDir?: string;
  defaultModel?: string;
}

export function createAgyParseState(
  brainBaseDir?: string,
  defaultModel?: string,
): AgyParseState {
  return {
    pendingToolIds: [],
    pendingSubagents: [],
    brainBaseDir,
    defaultModel,
  };
}

export function parseAgyTranscriptLine(
  raw: string,
  state: AgyParseState = createAgyParseState(),
): NormalizedHarnessEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const step = safeJsonParse<AgyTranscriptStep>(trimmed);
  if (!step || typeof step.type !== "string") return [];

  const timestamp = step.created_at;
  const stepKey = step.step_index !== undefined ? String(step.step_index) : String(Date.now());
  const model = step.model || state.defaultModel;
  const events: NormalizedHarnessEvent[] = [];

  if (step.type === "USER_INPUT") {
    const text = extractAgyUserText(step.content ?? "");
    if (text) {
      events.push({
        id: `agy-user-${stepKey}`,
        type: "user",
        role: "user",
        text,
        timestamp,
      });
    }
    return events;
  }

  if (step.type === "PLANNER_RESPONSE") {
    state.pendingToolIds = [];

    if (step.thinking && step.thinking.trim()) {
      events.push({
        id: `agy-think-${stepKey}`,
        type: "tool",
        tool: "Thinking",
        toolInput: { thinking: step.thinking },
        model,
        text: truncate(step.thinking.trim(), 120),
        timestamp,
      });
    }

    if (Array.isArray(step.tool_calls)) {
      for (let i = 0; i < step.tool_calls.length; i++) {
        const tc = step.tool_calls[i];
        if (!tc?.name) continue;
        const toolUseId = tc.id ?? `agy-tc-${stepKey}-${i}`;
        const args = normalizeAgyToolArgs(tc.args);
        state.pendingToolIds.push(toolUseId);

        if (tc.name === "invoke_subagent") {
          const obj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
          const role =
            typeof obj["Role"] === "string" && obj["Role"].trim()
              ? obj["Role"].trim()
              : typeof obj["TypeName"] === "string" && obj["TypeName"].trim()
                ? obj["TypeName"].trim()
                : "Subagent";
          const agentType =
            typeof obj["TypeName"] === "string" && obj["TypeName"].trim()
              ? obj["TypeName"].trim()
              : undefined;
          state.pendingSubagents.push({ toolUseId, role, agentType });
          events.push({
            id: toolUseId,
            type: "task",
            tool: "invoke_subagent",
            toolUseId,
            toolInput: args,
            model,
            text: formatAgyToolSummary(tc.name, args),
            parentToolUseId: toolUseId,
            timestamp,
          });
        } else {
          events.push({
            id: toolUseId,
            type: "tool",
            tool: tc.name,
            toolUseId,
            toolInput: args,
            model,
            text: formatAgyToolSummary(tc.name, args),
            timestamp,
          });
          if (tc.name === "ask_question") {
            const interaction = parseAgyQuestionInteraction(toolUseId, args, timestamp);
            if (interaction) {
              events.push({
                id: `interaction-${interaction.id}`,
                type: "interaction",
                toolUseId,
                interaction,
                timestamp,
              });
            }
          }
        }
      }
    }

    if (step.content && step.content.trim()) {
      events.push({
        id: `agy-msg-${stepKey}`,
        type: "delta",
        role: "assistant",
        text: step.content,
        model,
        timestamp,
      });
    }

    if (step.input_tokens !== undefined || step.output_tokens !== undefined) {
      events.push({
        type: "result",
        usage: {
          inputTokens: (step.input_tokens ?? 0) + (step.cache_read_tokens ?? 0),
          outputTokens: step.output_tokens ?? 0,
          contextWindow: 1_000_000,
        },
        model,
        timestamp,
      });
    }
    return events;
  }

  if (step.type === "GENERIC" || step.type === "TOOL_RESULT") {
    const content = step.content ?? "";
    const linkedToolUseId = state.pendingToolIds.shift();

    // Detect subagent conversationId returned by invoke_subagent.
    const convMatch =
      content.match(/conversation:\/\/([a-zA-Z0-9_-]+)/) ??
      content.match(/"conversationId"\s*:\s*"([a-zA-Z0-9_-]+)"/) ??
      content.match(/conversationId:\s*([a-zA-Z0-9_-]+)/);
    if (convMatch?.[1] && state.brainBaseDir) {
      const subConvId = convMatch[1];
      const subTranscript = join(
        state.brainBaseDir,
        subConvId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      const pendingSub = state.pendingSubagents.shift();
      events.push({
        type: "agent_updated",
        agentId: pendingSub?.toolUseId ?? subConvId,
        agent: {
          agentId: pendingSub?.toolUseId ?? subConvId,
          parentAgentId: "main",
          role: pendingSub?.role ?? `Subagent (${subConvId.slice(0, 8)})`,
          agentType: pendingSub?.agentType,
          transcriptPath: subTranscript,
          canSendInput: false,
          state: step.status === "DONE" ? "thinking" : "thinking",
          updatedAt: timestamp ?? new Date().toISOString(),
        },
        timestamp,
      });
    }

    events.push({
      id: `agy-res-${stepKey}`,
      type: "tool",
      tool: "tool_result",
      toolUseId: linkedToolUseId,
      text: content ? truncate(content, 200) : undefined,
      timestamp,
    });
    if (linkedToolUseId) {
      events.push({
        id: `resolved-${linkedToolUseId}`,
        type: "interaction_resolved",
        toolUseId: linkedToolUseId,
        interactionId: linkedToolUseId,
        timestamp,
      });
    }
    return events;
  }

  if (step.type === "ERROR" && step.content) {
    events.push({
      id: `agy-err-${stepKey}`,
      type: "error",
      message: step.content,
      timestamp,
    });
  }

  return events;
}

export interface AgyTranscriptMetadata {
  externalSessionId: string;
  cwd?: string;
  model?: string;
  lastMessagePreview?: string;
  messageCount: number;
  updatedAt?: string;
}

export function inspectAgyTranscript(
  convId: string,
  transcriptPath: string,
): AgyTranscriptMetadata | null {
  if (!existsSync(transcriptPath)) return null;
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n");
    let cwd: string | undefined;
    let model: string | undefined;
    let lastMessagePreview: string | undefined;
    let messageCount = 0;
    let updatedAt: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const step = safeJsonParse<AgyTranscriptStep>(trimmed);
      if (!step) continue;

      if (step.created_at) updatedAt = step.created_at;
      if (step.cwd && !cwd) cwd = step.cwd;
      if (step.model) model = step.model;

      if (step.type === "USER_INPUT" && step.content) {
        if (!cwd) cwd = extractAgyCwdFromContent(step.content);
        const text = extractAgyUserText(step.content).replace(/\s+/g, " ").trim();
        if (text) {
          messageCount += 1;
          lastMessagePreview = truncate(text, 80);
        }
      }
    }

    if (messageCount === 0 && !cwd) return null;
    return {
      externalSessionId: convId,
      cwd,
      model,
      lastMessagePreview,
      messageCount,
      updatedAt,
    };
  } catch {
    return null;
  }
}
