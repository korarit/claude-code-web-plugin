import type {
  FileDiffMode,
  FileDiffResponse,
  RawFileResponse,
  RevertFileResponse,
  SessionChangesResponse,
} from "@contracts/changes";
import type {
  ChatInputRequest,
  ChatSendRequest,
  ChatStreamEvent,
  ConcurrencyWarning,
  ModelId,
  ResumeSessionRequest,
  SessionInfo,
  SessionOrigin,
  SessionsListEvent,
  SessionUpdateRequest,
  TerminalClientMessage,
  TerminalServerMessage,
  UploadImageResponse,
  WorkspaceFileEntry,
} from "@contracts/chat";
import type { ApiResponse } from "@contracts/http";
import { safeJsonParse } from "@core/utils";

export interface HealthInfo {
  ok: boolean;
  tmuxAvailable: boolean;
  defaultCwd?: string;
  apiKeyConfigured?: boolean;
  concurrencySoftLimit?: number;
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

export async function sendChat(req: ChatSendRequest): Promise<{
  session: SessionInfo;
  isNewSession: boolean;
  concurrencyWarning?: ConcurrencyWarning;
}> {
  const res = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return parseApiJson<{
    session: SessionInfo;
    isNewSession: boolean;
    concurrencyWarning?: ConcurrencyWarning;
  }>(res);
}

export async function resumeSession(
  sessionId: string,
  req: ResumeSessionRequest = {},
): Promise<{ session: SessionInfo; concurrencyWarning?: ConcurrencyWarning }> {
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return parseApiJson<{ session: SessionInfo; concurrencyWarning?: ConcurrencyWarning }>(res);
}

export async function sendInput(
  req: ChatInputRequest,
): Promise<{ session: SessionInfo; method: "hook" | "tmux"; resolved: boolean }> {
  const res = await fetch("/api/chat/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return parseApiJson<{ session: SessionInfo; method: "hook" | "tmux"; resolved: boolean }>(res);
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

export async function fetchWorkspaceFiles(
  cwd?: string,
  q?: string,
): Promise<WorkspaceFileEntry[]> {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (q) params.set("q", q);
  const qs = params.toString();
  const res = await fetch(`/api/workspace/files${qs ? `?${qs}` : ""}`);
  const data = await parseApiJson<{ files: WorkspaceFileEntry[] }>(res);
  return data.files;
}

export async function uploadChatImage(
  file: File,
  cwd?: string,
): Promise<UploadImageResponse> {
  const form = new FormData();
  form.append("file", file);
  if (cwd) form.append("cwd", cwd);
  const res = await fetch("/api/chat/upload", {
    method: "POST",
    body: form,
  });
  return parseApiJson<UploadImageResponse>(res);
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
  "interaction",
  "interaction_resolved",
  "file_changed",
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

export function connectTerminalWs(
  sessionId: string,
  handlers: {
    onMessage: (msg: TerminalServerMessage) => void;
    onOpen?: () => void;
    onClose?: () => void;
  },
): {
  send: (msg: TerminalClientMessage) => void;
  close: () => void;
} {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/chat/sessions/${encodeURIComponent(sessionId)}/terminal`;
  const ws = new WebSocket(url);

  ws.onopen = () => handlers.onOpen?.();
  ws.onclose = () => handlers.onClose?.();
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const parsed = safeJsonParse<TerminalServerMessage>(ev.data);
    if (parsed) handlers.onMessage(parsed);
  };

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => {
      ws.close();
    },
  };
}

export async function fetchSessionChanges(
  sessionId: string,
  mode: FileDiffMode = "session",
): Promise<SessionChangesResponse> {
  const params = new URLSearchParams({ mode });
  const res = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/changes?${params.toString()}`,
  );
  return parseApiJson<SessionChangesResponse>(res);
}

export async function fetchFileDiff(
  sessionId: string,
  path: string,
  mode: FileDiffMode = "session",
  revId?: string,
): Promise<FileDiffResponse> {
  const params = new URLSearchParams({ path, mode });
  if (revId) params.set("revId", revId);
  const res = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/changes/diff?${params.toString()}`,
  );
  return parseApiJson<FileDiffResponse>(res);
}

export async function fetchRawFile(
  sessionId: string,
  path: string,
): Promise<RawFileResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/files/raw?${params.toString()}`,
  );
  return parseApiJson<RawFileResponse>(res);
}

export async function revertFileChange(
  sessionId: string,
  path: string,
  mode: FileDiffMode = "session",
): Promise<RevertFileResponse> {
  const res = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/changes/revert`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, mode }),
    },
  );
  return parseApiJson<RevertFileResponse>(res);
}
