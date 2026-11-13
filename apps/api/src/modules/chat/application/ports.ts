import type {
  AuthMode,
  ChatInputRequest,
  DiscoveredExternalSession,
  HarnessId,
  ModelId,
  PendingInteraction,
  UploadImageResponse,
  WorkspaceFileEntry,
} from "@contracts/index";
import type { DomainChatEvent, DomainHookEvent, SessionListEvent } from "../domain/chat.events.ts";

export interface EnsureSessionOptions {
  sessionId: string;
  model: ModelId;
  cwd: string;
  port: number;
  token: string;
  resumeSessionId?: string;
  authMode?: AuthMode;
  apiKey?: string;
  agentProfile?: string;
  tmuxSessionName?: string;
}

export interface EnsureSessionResult {
  tmuxSession: string;
  isNew: boolean;
}

export interface ActiveTerminalSession {
  name: string;
  cwd?: string;
  paneCommand?: string;
  panePid?: number;
}

export interface TerminalRunnerPort {
  isAvailable(): Promise<boolean>;
  ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult>;
  sendPrompt(tmuxSession: string, prompt: string): Promise<void>;
  sendRawKeys(tmuxSession: string, keys: string): Promise<void>;
  sendKeysSequence?(tmuxSession: string, keys: string[]): Promise<void>;
  capturePane?(tmuxSession: string, lines?: number): Promise<string>;
  abortSession(tmuxSession: string): Promise<void>;
  stopSession(tmuxSession: string): Promise<void>;
  listActiveSessions(): Promise<ActiveTerminalSession[]>;
  notifyReady?(sessionId: string): void;
}

export interface TerminalAttachment {
  sendKey(key: string): Promise<void>;
  sendText(text: string): Promise<void>;
  close(): void;
}

export interface TerminalAttachPort {
  attach(
    tmuxSession: string,
    onScreen: (content: string) => void,
    onError: (message: string) => void,
  ): TerminalAttachment;
}

export interface TranscriptWatcherPort {
  resolveTranscriptPath(cwd: string, sessionId: string): string;
  watch(
    sessionId: string,
    transcriptPath: string,
    onEvent: (event: DomainChatEvent) => void,
    options?: { fromBeginning?: boolean },
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

export interface WorkspacePort {
  listFiles(cwd: string, query?: string, limit?: number): Promise<WorkspaceFileEntry[]>;
  saveImage(cwd: string, filename: string, bytes: Uint8Array): Promise<UploadImageResponse>;
}

export interface FileChangeToolInput {
  sessionId: string;
  cwd: string;
  harnessId: string;
  model: string;
  toolName: string;
  toolUseId?: string;
  toolInput?: unknown;
  agentId?: string;
  editedAt?: string;
}

export interface FileChangeTrackerPort {
  onPreToolUse(input: FileChangeToolInput): Promise<void>;
  onPostToolUse(input: FileChangeToolInput): Promise<void>;
  deleteSession?(sessionId: string): Promise<void>;
}

export interface AgentTelemetryPort {
  onHookEvent(sessionId: string, hook: DomainHookEvent, externalSessionId?: string): Promise<void>;
  onTranscriptEvent(sessionId: string, event: DomainChatEvent): Promise<void>;
  deleteSession?(sessionId: string): void;
}

export interface HarnessSessionRef {
  id: string;
  harnessId: HarnessId;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  model?: string;
}

export interface HarnessStartedResult {
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  isNew: boolean;
}

export interface HarnessGatewayPort {
  getDefaultModel(harnessId: HarnessId): string;
  isAvailable(harnessId: HarnessId): Promise<boolean>;
  startOrResumeSession(
    harnessId: HarnessId,
    options: EnsureSessionOptions,
  ): Promise<HarnessStartedResult>;
  sendPrompt(
    session: HarnessSessionRef,
    prompt: string,
    options?: { model?: string; agentProfile?: string },
  ): Promise<void>;
  sendInput(
    session: HarnessSessionRef,
    input: ChatInputRequest,
    pendingInteraction?: PendingInteraction | null,
  ): Promise<{ handled: boolean; method: "hook" | "tmux" | "server_api"; resolved: boolean }>;
  abortSession(session: HarnessSessionRef): Promise<void>;
  stopSession(session: HarnessSessionRef): Promise<void>;
  observeEvents(
    session: HarnessSessionRef,
    onEvent: (event: DomainChatEvent) => void,
    options?: { fromBeginning?: boolean },
  ): Promise<() => void>;
  readRecentEvents(session: HarnessSessionRef, limit?: number): Promise<DomainChatEvent[]>;
  discoverSessions?(): Promise<DiscoveredExternalSession[]>;
  watchExternalSessions?(onUpsert: (session: DiscoveredExternalSession) => void): () => void;
}
