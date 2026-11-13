import type { AgentNodeRecord, TeamTaskRecord } from "./agent-node.entity.ts";

export interface AgentsRepository {
  getAgents(sessionId: string): AgentNodeRecord[];
  saveAgents(sessionId: string, agents: AgentNodeRecord[]): void;
  getTasks(sessionId: string): TeamTaskRecord[];
  saveTasks(sessionId: string, tasks: TeamTaskRecord[]): void;
  deleteSession(sessionId: string): void;
}
