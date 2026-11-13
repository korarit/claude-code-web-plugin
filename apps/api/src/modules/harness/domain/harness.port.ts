import type { AgentNode } from "@contracts/agents";
import type { SessionFileChange } from "@contracts/changes";
import type {
  AuthMode,
  ChatEventType,
  ChatInputType,
  PendingInteraction,
  PermissionPromptPayload,
  SessionStatus,
} from "@contracts/chat";
import type {
  DiscoveredExternalSession,
  HarnessCapabilities,
  HarnessId,
} from "@contracts/harness";

export interface NormalizedHarnessEvent {
  id?: string;
  type: ChatEventType;
  role?: "user" | "assistant";
  text?: string;
  tool?: string;
  toolUseId?: string;
  toolInput?: unknown;
  parentToolUseId?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextWindow?: number;
  };
  costUsd?: number;
  status?: SessionStatus;
  permissionPrompt?: PermissionPromptPayload;
  interaction?: PendingInteraction;
  interactionId?: string;
  fileChange?: SessionFileChange;
  agent?: AgentNode;
  agents?: AgentNode[];
  agentId?: string;
  model?: string;
  message?: string;
  timestamp?: string;
  /** Optional adapter-discovered external metadata (e.g. AGY conversationId / transcriptPath). */
  discoveredExternalSessionId?: string;
  discoveredTranscriptPath?: string;
}

export interface StartHarnessSessionOptions {
  sessionId: string;
  model: string;
  cwd: string;
  port: number;
  token: string;
  resumeSessionId?: string;
  authMode?: AuthMode;
  apiKey?: string;
  agentProfile?: string;
  tmuxSessionName?: string;
}

export interface StartedHarnessSession {
  harnessId: HarnessId;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  serverUrl?: string;
  isNew: boolean;
}

export interface HarnessSessionContext {
  sessionId: string;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
  cwd?: string;
  model?: string;
}

export interface HarnessInputPayload {
  sessionId: string;
  externalSessionId?: string;
  tmuxSession?: string;
  cwd?: string;
  inputType: ChatInputType;
  value: string | string[] | Record<string, string | string[]>;
  interactionId?: string;
  pendingInteraction?: PendingInteraction | null;
}

export interface HarnessSendInputResult {
  handled: boolean;
  method: "hook" | "tmux" | "server_api";
  resolved: boolean;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly name: string;
  readonly binary: string;
  readonly capabilities: HarnessCapabilities;

  detectAvailability(): Promise<boolean>;
  listModels(): Promise<string[]>;
  listAgentProfiles?(): Promise<string[]>;
  getDefaultModel(): string;
  resolveTranscriptPath?(cwd: string, sessionOrExternalId: string): string;

  startOrResumeSession(options: StartHarnessSessionOptions): Promise<StartedHarnessSession>;
  sendPrompt(
    session: HarnessSessionContext,
    prompt: string,
    options?: { model?: string; agentProfile?: string },
  ): Promise<void>;
  sendInput?(payload: HarnessInputPayload): Promise<HarnessSendInputResult>;
  abortSession(session: HarnessSessionContext): Promise<void>;
  stopSession?(session: HarnessSessionContext): Promise<void>;

  observeEvents(
    session: HarnessSessionContext,
    onEvent: (event: NormalizedHarnessEvent) => void,
    options?: { fromBeginning?: boolean },
  ): Promise<() => void>;
  readRecentEvents?(
    session: HarnessSessionContext,
    limit?: number,
  ): Promise<NormalizedHarnessEvent[]>;

  discoverSessions(): Promise<DiscoveredExternalSession[]>;
  watchExternalSessions?(onUpsert: (session: DiscoveredExternalSession) => void): () => void;
  dispose?(): Promise<void> | void;
}
