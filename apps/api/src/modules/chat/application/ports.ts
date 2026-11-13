import type { ModelId } from "@contracts/chat";
import type { DomainChatEvent, SessionListEvent } from "../domain/chat.events.ts";

export interface EnsureSessionOptions {
  sessionId: string;
  model: ModelId;
  cwd: string;
  port: number;
  token: string;
  resumeSessionId?: string;
}

export interface EnsureSessionResult {
  tmuxSession: string;
  isNew: boolean;
}

export interface ActiveTerminalSession {
  name: string;
  cwd?: string;
}

export interface TerminalRunnerPort {
  isAvailable(): Promise<boolean>;
  ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult>;
  sendPrompt(tmuxSession: string, prompt: string): Promise<void>;
  sendRawKeys(tmuxSession: string, keys: string): Promise<void>;
  abortSession(tmuxSession: string): Promise<void>;
  stopSession(tmuxSession: string): Promise<void>;
  listActiveSessions(): Promise<ActiveTerminalSession[]>;
  notifyReady?(sessionId: string): void;
}

export interface TranscriptWatcherPort {
  resolveTranscriptPath(cwd: string, sessionId: string): string;
  watch(
    sessionId: string,
    transcriptPath: string,
    onEvent: (event: DomainChatEvent) => void,
  ): Promise<void>;
  unwatch(sessionId: string): void;
  readRecentEvents(transcriptPath: string, limit?: number): Promise<DomainChatEvent[]>;
}

export interface EventBusPort {
  publish(sessionId: string, event: DomainChatEvent): void;
  subscribe(sessionId: string, handler: (event: DomainChatEvent) => void): () => void;
  getRecentEvents(sessionId: string): DomainChatEvent[];
  clearSession(sessionId: string): void;
  publishListEvent(event: SessionListEvent): void;
  subscribeListEvents(handler: (event: SessionListEvent) => void): () => void;
}
