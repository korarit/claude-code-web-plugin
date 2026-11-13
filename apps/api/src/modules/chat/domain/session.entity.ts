import type {
  HarnessId,
  ModelId,
  SessionControlMode,
  SessionOrigin,
  SessionStatus,
} from "@contracts/chat";
import { isoNow, type Clock } from "@core/time";
import { truncate } from "@core/utils";

export interface Session {
  id: string;
  title?: string;
  model: ModelId;
  harnessId: HarnessId;
  status: SessionStatus;
  origin: SessionOrigin;
  controlMode: SessionControlMode;
  externalSessionId?: string;
  discoveredAt?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  archivedAt?: string | null;
  lastMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface CreateSessionParams {
  id: string;
  model: ModelId;
  harnessId?: HarnessId;
  status?: SessionStatus;
  origin?: SessionOrigin;
  controlMode?: SessionControlMode;
  externalSessionId?: string;
  discoveredAt?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  title?: string;
}

export function createSession(params: CreateSessionParams, clock: Clock): Session {
  const now = isoNow(clock);
  return {
    id: params.id,
    title: params.title,
    model: params.model,
    harnessId: params.harnessId ?? "claude",
    status: params.status ?? "idle",
    origin: params.origin ?? "web",
    controlMode: params.controlMode ?? "interactive",
    externalSessionId: params.externalSessionId,
    discoveredAt: params.discoveredAt,
    tmuxSession: params.tmuxSession,
    transcriptPath: params.transcriptPath,
    cwd: params.cwd,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

export function markRunning(session: Session, clock: Clock, model?: ModelId): Session {
  return {
    ...session,
    model: model ?? session.model,
    status: "running",
    updatedAt: isoNow(clock),
  };
}

export function markIdle(session: Session, clock: Clock): Session {
  return {
    ...session,
    status: "idle",
    updatedAt: isoNow(clock),
  };
}

export function markWaitingPermission(session: Session, clock: Clock): Session {
  return {
    ...session,
    status: "waiting_permission",
    updatedAt: isoNow(clock),
  };
}

export function markStopped(session: Session, clock: Clock): Session {
  return {
    ...session,
    status: "stopped",
    updatedAt: isoNow(clock),
  };
}

export function attachTranscript(
  session: Session,
  transcriptPath: string,
  clock: Clock,
): Session {
  if (session.transcriptPath === transcriptPath) return session;
  return {
    ...session,
    transcriptPath,
    updatedAt: isoNow(clock),
  };
}

export function attachTmuxSession(
  session: Session,
  tmuxSession: string,
  clock: Clock,
): Session {
  if (session.tmuxSession === tmuxSession) return session;
  return {
    ...session,
    tmuxSession,
    updatedAt: isoNow(clock),
  };
}

export function renameSession(session: Session, title: string, clock: Clock): Session {
  const trimmed = title.trim();
  return {
    ...session,
    title: trimmed.length > 0 ? trimmed : undefined,
    updatedAt: isoNow(clock),
  };
}

export function archiveSession(session: Session, clock: Clock): Session {
  return {
    ...session,
    archivedAt: isoNow(clock),
    updatedAt: isoNow(clock),
  };
}

export function unarchiveSession(session: Session, clock: Clock): Session {
  return {
    ...session,
    archivedAt: null,
    updatedAt: isoNow(clock),
  };
}

export function recordPrompt(session: Session, prompt: string, clock: Clock): Session {
  const preview = truncate(prompt.replace(/\s+/g, " ").trim(), 80);
  return {
    ...session,
    lastMessagePreview: preview || session.lastMessagePreview,
    updatedAt: isoNow(clock),
    messageCount: session.messageCount + 1,
  };
}
