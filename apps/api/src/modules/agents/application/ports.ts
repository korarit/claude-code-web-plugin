import type {
  AgentNodeRecord,
  AgentUsageRecord,
  TeamTaskRecord,
} from "../domain/agent-node.entity.ts";

export interface SessionAgentInfo {
  id: string;
  title?: string;
  model: string;
  status: string;
  harnessId: string;
  externalSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  updatedAt: string;
}

export interface SessionAgentLookupPort {
  getSession(sessionId: string): SessionAgentInfo | null;
  listSessionIds?(): string[];
}

export interface AgentFileChangeInput {
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

export interface AgentFileChangeTrackerPort {
  onPreToolUse(input: AgentFileChangeInput): Promise<void>;
  onPostToolUse(input: AgentFileChangeInput): Promise<void>;
}

export interface AgentTranscriptEvent {
  id?: string;
  type: string;
  role?: "user" | "assistant";
  text?: string;
  tool?: string;
  toolUseId?: string;
  toolInput?: unknown;
  parentToolUseId?: string | null;
  agentId?: string;
  usage?: AgentUsageRecord;
  costUsd?: number;
  model?: string;
  message?: string;
  agentRecord?: AgentNodeRecord;
  timestamp?: string;
}

export interface AgentTranscriptWatcherPort {
  watchFromStart(
    watchKey: string,
    transcriptPath: string,
    onEvent: (event: AgentTranscriptEvent) => void,
  ): Promise<void>;
  unwatch(watchKey: string): void;
  readRecentEvents(transcriptPath: string, limit?: number): Promise<AgentTranscriptEvent[]>;
}

export interface AgentTeamTasksWatcherPort {
  readTeamTasks(sessionId: string, externalSessionId?: string): Promise<TeamTaskRecord[]>;
  watchTeamTasks(
    sessionId: string,
    externalSessionId: string | undefined,
    onChange: () => void,
  ): void;
  unwatchTeamTasks(sessionId: string): void;
}

export interface AgentEventPublisherPort {
  publishAgentUpdated(sessionId: string, agent: AgentNodeRecord): void;
  publishTasksUpdated(sessionId: string, tasks: TeamTaskRecord[]): void;
  publishAgentStreamEvent(sessionId: string, agentId: string, event: AgentTranscriptEvent): void;
  subscribeAgentStream(
    sessionId: string,
    agentId: string,
    handler: (event: AgentTranscriptEvent) => void,
  ): () => void;
  getRecentAgentStreamEvents(sessionId: string, agentId: string): AgentTranscriptEvent[];
  clearSession(sessionId: string): void;
}

export interface AgentHookInput {
  sessionId: string;
  externalSessionId?: string;
  cwd?: string;
  hookEventName: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  teammateName?: string;
  taskId?: string;
  taskSubject?: string;
  taskStatus?: string;
  timestamp?: string;
}
