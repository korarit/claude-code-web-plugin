import type {
  ChatSendRequest,
  ChatStreamEvent,
  ModelId,
  SessionInfo,
  SessionOrigin,
  SessionsListEvent,
  SessionUpdateRequest,
} from "@contracts/chat";
import type { ApiResponse } from "@contracts/http";
import { safeJsonParse } from "@core/utils";

export interface HealthInfo {
  ok: boolean;
  tmuxAvailable: boolean;
  defaultCwd?: string;
}

export interface SessionListQuery {
  archived?: boolean | "all";
  origin?: SessionOrigin | "all";
  cwd?: string;
  q?: string;
}

async function parseApiJson<T>(res: Response): Promise<T> {
  const payload = (await res.json()) as ApiResponse<T>;
  if (!res.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `Request failed (${res.status})`);
  }
  return payload.data;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch("/api/health");
  return parseApiJson<HealthInfo>(res);
}

export async function fetchModels(): Promise<ModelId[]> {
  const res = await fetch("/api/models");
  const data = await parseApiJson<{ models: ModelId[] }>(res);
  return data.models;
}

export async function fetchSessions(query: SessionListQuery = {}): Promise<SessionInfo[]> {
  const params = new URLSearchParams();
  if (query.archived !== undefined) params.set("archived", String(query.archived));
  if (query.origin && query.origin !== "all") params.set("origin", query.origin);
  if (query.cwd) params.set("cwd", query.cwd);
  if (query.q) params.set("q", query.q);
  const qs = params.toString();
  const res = await fetch(`/api/chat/sessions${qs ? `?${qs}` : ""}`);
  const data = await parseApiJson<{ sessions: SessionInfo[] }>(res);
  return data.sessions;
}

export async function sendChat(
  req: ChatSendRequest,
): Promise<{ session: SessionInfo; isNewSession: boolean }> {
  const res = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return parseApiJson<{ session: SessionInfo; isNewSession: boolean }>(res);
}

export async function updateSession(
  sessionId: string,
  req: SessionUpdateRequest,
): Promise<SessionInfo> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await parseApiJson<{ session: SessionInfo }>(res);
  return data.session;
}

export async function abortSession(sessionId: string): Promise<SessionInfo> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/abort`, {
    method: "POST",
  });
  const data = await parseApiJson<{ session: SessionInfo }>(res);
  return data.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  await parseApiJson<{ deleted: boolean; id: string }>(res);
}

const CHAT_EVENT_TYPES = [
  "init",
  "user",
  "delta",
  "tool",
  "task",
  "result",
  "error",
  "status",
  "permission_prompt",
] as const;

export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: ChatStreamEvent) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource(`/api/chat/sessions/${encodeURIComponent(sessionId)}/events`);

  const handle = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const parsed = safeJsonParse<ChatStreamEvent>(ev.data);
    if (parsed && typeof parsed.type === "string") {
      onEvent(parsed);
    }
  };

  for (const type of CHAT_EVENT_TYPES) {
    es.addEventListener(type, handle as EventListener);
  }
  es.onerror = () => {
    onError?.();
  };

  return () => {
    es.close();
  };
}

export function subscribeSessionsListEvents(
  onEvent: (event: SessionsListEvent) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource("/api/chat/sessions/events");

  const handle = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const parsed = safeJsonParse<SessionsListEvent>(ev.data);
    if (parsed && typeof parsed.type === "string") {
      onEvent(parsed);
    }
  };

  es.addEventListener("snapshot", handle as EventListener);
  es.addEventListener("upsert", handle as EventListener);
  es.addEventListener("delete", handle as EventListener);
  es.onerror = () => {
    onError?.();
  };

  return () => {
    es.close();
  };
}
