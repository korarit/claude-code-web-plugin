import type { HarnessId } from "@contracts/harness";
import { truncate } from "@core/utils";
import type { CanonicalEvent, CanonicalSession } from "../domain/canonical-session.entity.ts";

function formatHarnessDisplayName(harnessId: HarnessId): string {
  switch (harnessId) {
    case "claude":
      return "Claude CLI";
    case "agy":
      return "Antigravity CLI";
    case "opencode":
      return "OpenCode";
  }
}

function formatSingleEventVerbatim(event: CanonicalEvent): string {
  const sourceLabel = `${formatHarnessDisplayName(event.harnessId)}${event.model ? ` (${event.model})` : ""}`;
  if (event.kind === "message" && event.role === "user") {
    return `[Turn #${event.seq} · User]\n${event.text ?? ""}`;
  }
  if (event.kind === "message" && event.role === "assistant") {
    return `[Turn #${event.seq} · Assistant via ${sourceLabel}]\n${event.text ?? ""}`;
  }
  if (event.kind === "tool_call") {
    const inputText =
      event.toolInput !== undefined ? `\nInput: ${JSON.stringify(event.toolInput)}` : "";
    const filesText =
      event.filesTouched && event.filesTouched.length > 0
        ? `\nFiles touched: ${event.filesTouched.join(", ")}`
        : "";
    return `[Turn #${event.seq} · Tool ${event.toolName ?? "tool"} via ${sourceLabel}]${event.text ? `\n${event.text}` : ""}${filesText}${inputText}`;
  }
  if (event.kind === "tool_result") {
    return `[Turn #${event.seq} · Tool Result${event.toolUseId ? ` (${event.toolUseId})` : ""}]\n${event.toolOutput ?? event.text ?? ""}`;
  }
  if (event.kind === "error") {
    return `[Turn #${event.seq} · Error via ${sourceLabel}]\n${event.text ?? ""}`;
  }
  return `[Turn #${event.seq} · ${event.role}]\n${event.text ?? ""}`;
}

export function formatDirectVerbatimPrompt(params: {
  delta: CanonicalEvent[];
  targetHarness: HarnessId;
  newPrompt: string;
}): string {
  const { delta, targetHarness, newPrompt } = params;
  if (delta.length === 0) return newPrompt;

  const fromSeq = delta[0]!.seq;
  const toSeq = delta[delta.length - 1]!.seq;
  const lines = delta.map(formatSingleEventVerbatim).join("\n\n");

  return [
    `<!-- harness-web-sync:from=${fromSeq}:to=${toSeq}:strategy=direct_verbatim -->`,
    `[Cross-Harness Full-Verbatim Sync for ${formatHarnessDisplayName(targetHarness)} · Turns #${fromSeq}–#${toSeq}]`,
    `Continue this exact session seamlessly using the full verbatim history below before answering the new user request.`,
    "",
    lines,
    `<!-- /harness-web-sync -->`,
    "",
    newPrompt,
  ].join("\n");
}

export function formatSyncMarkdownDocument(params: {
  session: CanonicalSession;
  delta: CanonicalEvent[];
}): string {
  const { session, delta } = params;
  const fromSeq = delta[0]?.seq ?? 0;
  const toSeq = delta[delta.length - 1]?.seq ?? 0;
  const header = [
    `# Cross-Harness Full-Verbatim Sync`,
    `- Canonical Session: \`${session.canonicalSessionId}\``,
    `- Range: turns #${fromSeq} to #${toSeq} (${delta.length} events)`,
    `- Workspace: \`${session.cwd ?? ""}\``,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  const body = delta.map(formatSingleEventVerbatim).join("\n\n---\n\n");
  return [...header, body, ""].join("\n");
}

export function formatFileSyncPrompt(params: {
  syncFilePath: string;
  delta: CanonicalEvent[];
  tailCount?: number;
  targetHarness: HarnessId;
  newPrompt: string;
}): string {
  const { syncFilePath, delta, tailCount = 8, targetHarness, newPrompt } = params;
  const fromSeq = delta[0]?.seq ?? 0;
  const toSeq = delta[delta.length - 1]?.seq ?? 0;
  const recentTail = delta.slice(-tailCount);
  const tailText = recentTail.map(formatSingleEventVerbatim).join("\n\n");

  return [
    `<!-- harness-web-sync:from=${fromSeq}:to=${toSeq}:strategy=file_sync -->`,
    `[Large-History Cross-Harness Sync for ${formatHarnessDisplayName(targetHarness)} · Turns #${fromSeq}–#${toSeq}]`,
    `Full verbatim transcript (${delta.length} events) has been saved to: ${syncFilePath}`,
    `Read ${syncFilePath} first if you need exact details from earlier turns (#${fromSeq}–#${Math.max(fromSeq, (recentTail[0]?.seq ?? toSeq) - 1)}).`,
    `Most recent verbatim turns included inline below:`,
    "",
    tailText,
    `<!-- /harness-web-sync -->`,
    "",
    newPrompt,
  ].join("\n");
}

export interface OpenCodeImportMessage {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    parentID?: string;
    modelID?: string;
    providerID?: string;
  };
  parts: Array<Record<string, unknown>>;
}

export interface OpenCodeImportPayload {
  info: {
    id: string;
    title: string;
    directory: string;
    time: { created: number; updated: number };
  };
  messages: OpenCodeImportMessage[];
}

export function buildOpenCodeImportPayload(params: {
  canonicalSession: CanonicalSession;
  events: CanonicalEvent[];
  externalSessionId: string;
}): OpenCodeImportPayload {
  const { canonicalSession, events, externalSessionId } = params;
  const createdMs = Date.parse(canonicalSession.createdAt) || Date.now();
  const updatedMs = Date.parse(canonicalSession.updatedAt) || Date.now();
  const messages: OpenCodeImportMessage[] = [];
  let lastUserMsgId: string | undefined;

  for (const ev of events) {
    if (ev.kind === "harness_switched") continue;
    const tsMs = Date.parse(ev.ts) || createdMs;
    const msgId = `msg-imp-${ev.seq}`;

    if (ev.role === "user") {
      lastUserMsgId = msgId;
      messages.push({
        info: {
          id: msgId,
          sessionID: externalSessionId,
          role: "user",
          time: { created: tsMs },
        },
        parts: [
          {
            id: `prt-imp-${ev.seq}-0`,
            sessionID: externalSessionId,
            messageID: msgId,
            type: "text",
            text: ev.text ?? "",
          },
        ],
      });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (ev.kind === "message" && ev.text) {
      parts.push({
        id: `prt-imp-${ev.seq}-0`,
        sessionID: externalSessionId,
        messageID: msgId,
        type: "text",
        text: ev.text,
      });
    } else if (ev.kind === "tool_call") {
      parts.push({
        id: `prt-imp-${ev.seq}-0`,
        sessionID: externalSessionId,
        messageID: msgId,
        type: "tool",
        callID: ev.toolUseId ?? `call-${ev.seq}`,
        tool: ev.toolName ?? "tool",
        state: {
          status: "completed",
          input: ev.toolInput ?? {},
          output: truncate(ev.text ?? "", 500),
        },
      });
    } else if (ev.kind === "tool_result") {
      parts.push({
        id: `prt-imp-${ev.seq}-0`,
        sessionID: externalSessionId,
        messageID: msgId,
        type: "text",
        text: `[Tool Result] ${ev.toolOutput ?? ev.text ?? ""}`,
      });
    } else if (ev.kind === "error") {
      parts.push({
        id: `prt-imp-${ev.seq}-0`,
        sessionID: externalSessionId,
        messageID: msgId,
        type: "text",
        text: `[Error] ${ev.text ?? ""}`,
      });
    }

    if (parts.length > 0) {
      const slash = ev.model?.indexOf("/") ?? -1;
      messages.push({
        info: {
          id: msgId,
          sessionID: externalSessionId,
          role: "assistant",
          parentID: lastUserMsgId,
          modelID: slash > 0 && ev.model ? ev.model.slice(slash + 1) : ev.model,
          providerID: slash > 0 && ev.model ? ev.model.slice(0, slash) : undefined,
          time: { created: tsMs, completed: tsMs },
        },
        parts,
      });
    }
  }

  return {
    info: {
      id: externalSessionId,
      title: canonicalSession.title ?? "Synced Session",
      directory: canonicalSession.cwd ?? process.cwd(),
      time: { created: createdMs, updated: updatedMs },
    },
    messages,
  };
}
