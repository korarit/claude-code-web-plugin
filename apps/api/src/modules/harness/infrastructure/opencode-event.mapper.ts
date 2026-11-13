import type { PendingInteraction, QuestionItem } from "@contracts/chat";
import { truncate } from "@core/utils";
import type { NormalizedHarnessEvent } from "../domain/harness.port.ts";

export interface OpenCodeMapperState {
  sessionId: string;
  externalSessionId: string;
  childSessionIds: Set<string>;
  childTitles: Map<string, string>;
  messageRoles: Map<string, "user" | "assistant">;
  messageModels: Map<string, string>;
  partTextLengths: Map<string, number>;
  startedToolCalls: Set<string>;
  completedToolCalls: Set<string>;
}

export function createOpenCodeMapperState(
  sessionId: string,
  externalSessionId: string,
): OpenCodeMapperState {
  return {
    sessionId,
    externalSessionId,
    childSessionIds: new Set(),
    childTitles: new Map(),
    messageRoles: new Map(),
    messageModels: new Map(),
    partTextLengths: new Map(),
    startedToolCalls: new Set(),
    completedToolCalls: new Set(),
  };
}

export interface RawOpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export function unwrapOpenCodeEvent(raw: unknown): RawOpenCodeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj["payload"] && typeof obj["payload"] === "object") {
    const inner = obj["payload"] as Record<string, unknown>;
    if (typeof inner["type"] === "string") {
      return {
        type: inner["type"],
        properties: (inner["properties"] as Record<string, unknown>) ?? {},
      };
    }
  }
  if (typeof obj["type"] === "string") {
    return {
      type: obj["type"],
      properties: (obj["properties"] as Record<string, unknown>) ?? {},
    };
  }
  return null;
}

function formatOpenCodeToolSummary(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return tool;
  const obj = input as Record<string, unknown>;
  const target =
    obj["filePath"] ??
    obj["file_path"] ??
    obj["path"] ??
    obj["command"] ??
    obj["pattern"] ??
    obj["url"] ??
    obj["description"];
  if (typeof target === "string" && target.trim()) {
    return `${tool}: ${truncate(target.trim(), 100)}`;
  }
  return tool;
}

function mapOpenCodeQuestions(rawQuestions: unknown): QuestionItem[] {
  if (!Array.isArray(rawQuestions)) return [];
  const out: QuestionItem[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const prompt = typeof obj["question"] === "string" ? obj["question"] : "";
    if (!prompt) continue;
    const rawOpts = Array.isArray(obj["options"]) ? obj["options"] : [];
    const options = rawOpts
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
    out.push({
      id: typeof obj["header"] === "string" && obj["header"] ? obj["header"] : `q-${i}`,
      header: typeof obj["header"] === "string" ? obj["header"] : undefined,
      prompt,
      multiSelect: Boolean(obj["multiple"]),
      options,
      allowCustomText: obj["custom"] !== false,
    });
  }
  return out;
}

export function mapOpenCodeEvent(
  raw: unknown,
  state: OpenCodeMapperState,
): NormalizedHarnessEvent[] {
  const ev = unwrapOpenCodeEvent(raw);
  if (!ev) return [];
  const props = ev.properties ?? {};
  const now = new Date().toISOString();
  const events: NormalizedHarnessEvent[] = [];

  if (ev.type === "session.created" || ev.type === "session.updated") {
    const info = props["info"] as Record<string, unknown> | undefined;
    const id = typeof info?.["id"] === "string" ? info["id"] : undefined;
    const parentID = typeof info?.["parentID"] === "string" ? info["parentID"] : undefined;
    const title = typeof info?.["title"] === "string" ? info["title"] : undefined;

    if (id && parentID === state.externalSessionId) {
      state.childSessionIds.add(id);
      if (title) state.childTitles.set(id, title);
      events.push({
        type: "agent_updated",
        agentId: id,
        agent: {
          agentId: id,
          parentAgentId: "main",
          role: title || `Subagent (${id.slice(0, 8)})`,
          agentType: "opencode",
          canSendInput: false,
          state: "thinking",
          updatedAt: now,
        },
        timestamp: now,
      });
    }
    return events;
  }

  if (ev.type === "session.status") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    const st = props["status"] as { type?: string } | undefined;
    const mappedStatus = st?.type === "busy" || st?.type === "retry" ? "running" : "idle";

    if (sid === state.externalSessionId) {
      events.push({ type: "status", status: mappedStatus, timestamp: now });
    } else if (sid && state.childSessionIds.has(sid)) {
      events.push({
        type: "agent_updated",
        agentId: sid,
        agent: {
          agentId: sid,
          parentAgentId: "main",
          role: state.childTitles.get(sid) || `Subagent (${sid.slice(0, 8)})`,
          agentType: "opencode",
          canSendInput: false,
          state: mappedStatus === "running" ? "thinking" : "done",
          updatedAt: now,
        },
        timestamp: now,
      });
    }
    return events;
  }

  if (ev.type === "session.idle") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid === state.externalSessionId) {
      events.push({ type: "status", status: "idle", timestamp: now });
    } else if (sid && state.childSessionIds.has(sid)) {
      events.push({
        type: "agent_updated",
        agentId: sid,
        agent: {
          agentId: sid,
          parentAgentId: "main",
          role: state.childTitles.get(sid) || `Subagent (${sid.slice(0, 8)})`,
          agentType: "opencode",
          canSendInput: false,
          state: "done",
          updatedAt: now,
        },
        timestamp: now,
      });
    }
    return events;
  }

  if (ev.type === "session.error") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid && sid !== state.externalSessionId && !state.childSessionIds.has(sid)) {
      return [];
    }
    const errObj = props["error"] as Record<string, unknown> | undefined;
    const errMsg =
      typeof errObj?.["message"] === "string"
        ? errObj["message"]
        : typeof props["error"] === "string"
          ? props["error"]
          : "OpenCode session error";
    events.push({ type: "error", message: errMsg, timestamp: now });
    return events;
  }

  if (ev.type === "message.updated") {
    const info = props["info"] as Record<string, unknown> | undefined;
    const msgId = typeof info?.["id"] === "string" ? info["id"] : undefined;
    const sid = typeof info?.["sessionID"] === "string" ? info["sessionID"] : undefined;
    if (!msgId || (sid !== state.externalSessionId && !(sid && state.childSessionIds.has(sid)))) {
      return [];
    }

    const role = info?.["role"] === "user" ? "user" : "assistant";
    state.messageRoles.set(msgId, role);

    const providerID = typeof info?.["providerID"] === "string" ? info["providerID"] : undefined;
    const modelID = typeof info?.["modelID"] === "string" ? info["modelID"] : undefined;
    const fullModel =
      providerID && modelID ? `${providerID}/${modelID}` : (modelID ?? providerID);
    if (fullModel) state.messageModels.set(msgId, fullModel);

    const tokens = info?.["tokens"] as
      | { input?: number; output?: number; cache?: { read?: number; write?: number } }
      | undefined;
    if (role === "assistant" && tokens) {
      const inputTokens =
        (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
      events.push({
        type: "result",
        agentId: sid !== state.externalSessionId ? sid : undefined,
        model: fullModel,
        usage: {
          inputTokens,
          outputTokens: tokens.output ?? 0,
          contextWindow: 200_000,
        },
        costUsd: typeof info?.["cost"] === "number" ? info["cost"] : undefined,
        timestamp: now,
      });
    }
    return events;
  }

  if (ev.type === "message.part.updated") {
    const part = props["part"] as Record<string, unknown> | undefined;
    if (!part) return [];
    const sid = typeof part["sessionID"] === "string" ? part["sessionID"] : undefined;
    const isChild = Boolean(sid && state.childSessionIds.has(sid));
    if (sid !== state.externalSessionId && !isChild) return [];

    const agentId = isChild ? sid : undefined;
    const msgId = typeof part["messageID"] === "string" ? part["messageID"] : "";
    const role = state.messageRoles.get(msgId) ?? "assistant";
    const model = state.messageModels.get(msgId);
    const partId = typeof part["id"] === "string" ? part["id"] : `${msgId}-part`;
    const partType = typeof part["type"] === "string" ? part["type"] : "";

    if (partType === "text") {
      const fullText = typeof part["text"] === "string" ? part["text"] : "";
      const deltaProp = typeof props["delta"] === "string" ? props["delta"] : undefined;
      if (role === "user") {
        if (fullText && !state.partTextLengths.has(partId)) {
          state.partTextLengths.set(partId, fullText.length);
          events.push({
            id: partId,
            type: "user",
            role: "user",
            text: fullText,
            agentId,
            timestamp: now,
          });
        }
        return events;
      }

      if (deltaProp) {
        const prevLen = state.partTextLengths.get(partId) ?? 0;
        state.partTextLengths.set(partId, Math.max(prevLen + deltaProp.length, fullText.length));
        events.push({
          id: `${partId}-${prevLen}`,
          type: "delta",
          role: "assistant",
          text: deltaProp,
          model,
          agentId,
          timestamp: now,
        });
      } else if (fullText) {
        const prevLen = state.partTextLengths.get(partId) ?? 0;
        if (fullText.length > prevLen) {
          const chunk = fullText.slice(prevLen);
          state.partTextLengths.set(partId, fullText.length);
          events.push({
            id: `${partId}-${prevLen}`,
            type: "delta",
            role: "assistant",
            text: chunk,
            model,
            agentId,
            timestamp: now,
          });
        }
      }
      return events;
    }

    if (partType === "reasoning") {
      const text = typeof part["text"] === "string" ? part["text"] : "";
      if (text && !state.startedToolCalls.has(partId)) {
        state.startedToolCalls.add(partId);
        events.push({
          id: partId,
          type: "tool",
          tool: "Thinking",
          toolInput: { thinking: text },
          text: truncate(text, 120),
          model,
          agentId,
          timestamp: now,
        });
      }
      return events;
    }

    if (partType === "tool") {
      const toolName = typeof part["tool"] === "string" ? part["tool"] : "tool";
      const callId = typeof part["callID"] === "string" ? part["callID"] : partId;
      const toolState = (part["state"] as Record<string, unknown> | undefined) ?? {};
      const status = typeof toolState["status"] === "string" ? toolState["status"] : "running";
      const input = toolState["input"];

      if (
        (status === "pending" || status === "running" || status === "completed") &&
        !state.startedToolCalls.has(callId)
      ) {
        state.startedToolCalls.add(callId);
        events.push({
          id: callId,
          type: "tool",
          tool: toolName,
          toolUseId: callId,
          toolInput: input,
          model,
          agentId,
          text: formatOpenCodeToolSummary(toolName, input),
          timestamp: now,
        });
      }

      if ((status === "completed" || status === "error") && !state.completedToolCalls.has(callId)) {
        state.completedToolCalls.add(callId);
        const outputText =
          typeof toolState["output"] === "string"
            ? toolState["output"]
            : typeof toolState["error"] === "string"
              ? toolState["error"]
              : undefined;
        events.push({
          id: `${callId}-res`,
          type: "tool",
          tool: "tool_result",
          toolUseId: callId,
          model,
          agentId,
          text: outputText ? truncate(outputText, 200) : undefined,
          timestamp: now,
        });
      }
      return events;
    }

    return events;
  }

  if (ev.type === "permission.asked") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid !== state.externalSessionId && !(sid && state.childSessionIds.has(sid))) {
      return [];
    }
    const id = typeof props["id"] === "string" ? props["id"] : `perm-${Date.now()}`;
    const permission =
      typeof props["permission"] === "string" ? props["permission"] : "Permission";
    const patterns = Array.isArray(props["patterns"])
      ? props["patterns"].filter((p): p is string => typeof p === "string")
      : [];
    const target = patterns.join(", ") || undefined;
    const interaction: PendingInteraction = {
      id,
      sessionId: state.sessionId,
      kind: "permission",
      toolName: permission,
      commandOrTarget: target,
      message: target ? `OpenCode requested ${permission}: ${target}` : `OpenCode requested ${permission}`,
      options: [
        { id: "allow_once", label: "Allow Once" },
        { id: "always_allow", label: "Always Allow" },
        { id: "deny", label: "Deny" },
      ],
      createdAt: now,
    };
    events.push({
      type: "interaction",
      interaction,
      status: "waiting_permission",
      timestamp: now,
    });
    return events;
  }

  if (ev.type === "permission.replied") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid !== state.externalSessionId && !(sid && state.childSessionIds.has(sid))) {
      return [];
    }
    const requestID = typeof props["requestID"] === "string" ? props["requestID"] : undefined;
    events.push({
      type: "interaction_resolved",
      interactionId: requestID,
      timestamp: now,
    });
    return events;
  }

  if (ev.type === "question.asked") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid !== state.externalSessionId && !(sid && state.childSessionIds.has(sid))) {
      return [];
    }
    const id = typeof props["id"] === "string" ? props["id"] : `q-${Date.now()}`;
    const questions = mapOpenCodeQuestions(props["questions"]);
    if (questions.length > 0) {
      const interaction: PendingInteraction = {
        id,
        sessionId: state.sessionId,
        kind: "question",
        questions,
        createdAt: now,
      };
      events.push({
        type: "interaction",
        interaction,
        status: "waiting_permission",
        timestamp: now,
      });
    }
    return events;
  }

  if (ev.type === "question.replied" || ev.type === "question.rejected") {
    const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
    if (sid !== state.externalSessionId && !(sid && state.childSessionIds.has(sid))) {
      return [];
    }
    const requestID = typeof props["requestID"] === "string" ? props["requestID"] : undefined;
    events.push({
      type: "interaction_resolved",
      interactionId: requestID,
      timestamp: now,
    });
    return events;
  }

  return events;
}
