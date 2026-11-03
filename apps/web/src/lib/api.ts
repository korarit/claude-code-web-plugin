import type { ModelId, SessionInfo } from "@contracts/chat";
import type { ApiResponse } from "@contracts/http";

async function asJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.ok || body.data === undefined) {
    throw new Error(body.error?.message ?? `request failed: ${res.status}`);
  }
  return body.data;
}

export async function fetchModels(): Promise<ModelId[]> {
  const res = await fetch("/api/models");
  const data = await asJson<{ models: ModelId[] }>(res);
  return data.models;
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch("/api/chat/sessions");
  const data = await asJson<{ sessions: SessionInfo[] }>(res);
  return data.sessions;
}
