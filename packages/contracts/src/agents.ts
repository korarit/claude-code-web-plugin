export type AgentActivityState =
  | "thinking"
  | "reading"
  | "editing"
  | "running_cmd"
  | "waiting"
  | "idle"
  | "done";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface AgentNode {
  agentId: string;
  parentAgentId?: string;
  role: string;
  agentType?: string;
  transcriptPath?: string;
  canSendInput: boolean;
  state: AgentActivityState;
  currentTool?: string;
  currentTarget?: string;
  usage?: AgentUsage;
  recentLogs?: string[];
  startedAt?: string;
  updatedAt: string;
}

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTaskItem {
  id: string;
  subject: string;
  description?: string;
  owner?: string;
  status: TeamTaskStatus;
  source?: "todo" | "team_task";
  updatedAt?: string;
}

export interface SessionAgentsResponse {
  sessionId: string;
  agents: AgentNode[];
  tasks: TeamTaskItem[];
}

export interface AllAgentsResponse {
  bySession: Record<string, AgentNode[]>;
}
