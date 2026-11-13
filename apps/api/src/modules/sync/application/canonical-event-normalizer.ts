import type { HarnessId } from "@contracts/harness";
import type { AppendCanonicalEventInput } from "../domain/canonical-session.entity.ts";

const INJECTED_SYNC_BLOCK_RE =
  /<!--\s*harness-web-sync:from=\d+:to=\d+(?::strategy=[a-z_]+)?\s*-->[\s\S]*?<!--\s*\/harness-web-sync\s*-->\s*/g;

export function stripInjectedSyncPreamble(text: string): string {
  return text.replace(INJECTED_SYNC_BLOCK_RE, "").trim();
}

const FILE_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_file",
  "edit_file",
  "view_file",
  "edit",
  "write",
  "patch",
  "multiedit",
  "read",
]);

export function extractFilesTouched(toolName?: string, toolInput?: unknown): string[] | undefined {
  if (!toolName || !FILE_TOOL_NAMES.has(toolName)) return undefined;
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const obj = toolInput as Record<string, unknown>;
  const candidates = [
    obj["file_path"],
    obj["TargetFile"],
    obj["filePath"],
    obj["Path"],
    obj["path"],
  ];
  const files = candidates
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().replace(/^"|"$/g, ""));
  if (files.length === 0) return undefined;
  return [...new Set(files)];
}

export interface RawNormalizableEvent {
  id?: string;
  type: string;
  role?: "user" | "assistant";
  text?: string;
  tool?: string;
  toolUseId?: string;
  toolInput?: unknown;
  parentToolUseId?: string | null;
  agentId?: string;
  model?: string;
  message?: string;
  timestamp?: string;
  harnessId?: HarnessId;
  switchedFrom?: HarnessId;
  switchedTo?: HarnessId;
  syncedTurnsRange?: { fromSeq: number; toSeq: number };
}

export function normalizeEventToCanonical(params: {
  canonicalSessionId: string;
  harnessId: HarnessId;
  fallbackModel?: string;
  event: RawNormalizableEvent;
  fallbackTs: string;
  fallbackKey?: string;
}): AppendCanonicalEventInput | null {
  const { canonicalSessionId, harnessId, fallbackModel, event, fallbackTs, fallbackKey } = params;

  // Subagent-internal events stay in the subagent view and do not pollute main canonical history.
  if (event.agentId && event.agentId !== "main") {
    return null;
  }

  const ts = event.timestamp ?? fallbackTs;
  const model = event.model ?? fallbackModel;
  const effectiveHarness = event.harnessId ?? harnessId;

  if (event.type === "user" && event.text) {
    const clean = stripInjectedSyncPreamble(event.text);
    if (!clean) return null;
    const baseId = event.id ?? fallbackKey;
    return {
      canonicalSessionId,
      id: event.id ?? `ce-user-${Date.now()}`,
      sourceKey: baseId ? `${effectiveHarness}:user:${baseId}` : undefined,
      harnessId: effectiveHarness,
      model,
      role: "user",
      kind: "message",
      text: clean,
      ts,
    };
  }

  if (event.type === "delta" && event.text) {
    const baseId = event.id ?? fallbackKey;
    return {
      canonicalSessionId,
      id: event.id ?? `ce-delta-${Date.now()}`,
      sourceKey: baseId ? `${effectiveHarness}:delta:${baseId}` : undefined,
      harnessId: effectiveHarness,
      model,
      role: "assistant",
      kind: "message",
      text: event.text,
      ts,
    };
  }

  if (event.type === "tool" || event.type === "task") {
    if (event.tool === "Thinking") return null;

    if (event.tool === "tool_result") {
      const baseId = event.id ?? event.toolUseId ?? fallbackKey;
      return {
        canonicalSessionId,
        id: event.id ?? `ce-res-${event.toolUseId ?? Date.now()}`,
        sourceKey: baseId ? `${effectiveHarness}:tool_result:${event.toolUseId ?? ""}:${baseId}` : undefined,
        harnessId: effectiveHarness,
        model,
        role: "system",
        kind: "tool_result",
        toolName: "tool_result",
        toolUseId: event.toolUseId,
        toolOutput: event.text,
        ts,
      };
    }

    const toolName = event.tool ?? event.type;
    const baseId = event.toolUseId ?? event.id ?? fallbackKey;
    const filesTouched = extractFilesTouched(toolName, event.toolInput);
    return {
      canonicalSessionId,
      id: event.id ?? event.toolUseId ?? `ce-tool-${Date.now()}`,
      sourceKey: baseId ? `${effectiveHarness}:tool:${toolName}:${baseId}` : undefined,
      harnessId: effectiveHarness,
      model,
      role: "assistant",
      kind: "tool_call",
      text: event.text,
      toolCalls: [
        {
          id: event.toolUseId,
          name: toolName,
          input: event.toolInput,
        },
      ],
      toolName,
      toolUseId: event.toolUseId,
      toolInput: event.toolInput,
      filesTouched,
      ts,
    };
  }

  if (event.type === "error") {
    const errText = event.message ?? event.text;
    if (!errText) return null;
    const baseId = event.id ?? fallbackKey;
    return {
      canonicalSessionId,
      id: event.id ?? `ce-err-${Date.now()}`,
      sourceKey: baseId ? `${effectiveHarness}:error:${baseId}` : undefined,
      harnessId: effectiveHarness,
      model,
      role: "system",
      kind: "error",
      text: errText,
      ts,
    };
  }

  return null;
}
