import type { SessionControlMode, SessionOrigin } from "./chat.ts";

export type HarnessId = "claude" | "agy" | "opencode";

export interface HarnessCapabilities {
  hooks: boolean;
  jsonlTranscript: boolean;
  serverApi: boolean;
  resume: boolean;
  subagents: boolean;
  externalDiscovery: boolean;
}

export interface HarnessDescriptor {
  id: HarnessId;
  name: string;
  binary: string;
  available: boolean;
  models: string[];
  defaultModel: string;
  agentProfiles?: string[];
  capabilities: HarnessCapabilities;
}

export interface HarnessesListResponse {
  harnesses: HarnessDescriptor[];
}

export interface DiscoveredExternalSession {
  externalSessionId: string;
  harnessId: HarnessId;
  origin: SessionOrigin;
  controlMode: SessionControlMode;
  cwd?: string;
  transcriptPath?: string;
  tmuxSession?: string;
  model?: string;
  title?: string;
  lastMessagePreview?: string;
  messageCount?: number;
  isActiveTmux?: boolean;
  updatedAt: string;
}
