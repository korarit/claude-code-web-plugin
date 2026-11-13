import type {
  AgentNode,
  AllAgentsResponse,
  SessionAgentsResponse,
  TeamTaskItem,
} from "@contracts/agents";
import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import type { AgentNodeRecord, TeamTaskRecord } from "../domain/agent-node.entity.ts";
import type { AgentsRepository } from "../domain/agents.repository.port.ts";
import { AgentSessionNotFoundError } from "../domain/errors.ts";
import type { SessionAgentLookupPort } from "./ports.ts";
import { buildMainAgentRecord, type SyncAgentTelemetryUsecase } from "./sync-agent-telemetry.usecase.ts";

export function toAgentNodeContract(record: AgentNodeRecord): AgentNode {
  return {
    agentId: record.agentId,
    parentAgentId: record.parentAgentId,
    role: record.role,
    agentType: record.agentType,
    transcriptPath: record.transcriptPath,
    canSendInput: record.canSendInput,
    state: record.state,
    currentTool: record.currentTool,
    currentTarget: record.currentTarget,
    usage: record.usage ? { ...record.usage } : undefined,
    recentLogs: [...record.recentLogs],
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
}

export function toTeamTaskContract(record: TeamTaskRecord): TeamTaskItem {
  return {
    id: record.id,
    subject: record.subject,
    description: record.description,
    owner: record.owner,
    status: record.status,
    source: record.source,
    updatedAt: record.updatedAt,
  };
}

export class ListSessionAgentsUsecase {
  constructor(
    private readonly sessions: SessionAgentLookupPort,
    private readonly repo: AgentsRepository,
    private readonly syncUsecase?: SyncAgentTelemetryUsecase,
  ) {}

  async execute(sessionId: string): Promise<Result<SessionAgentsResponse, AppError>> {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      return err(new AgentSessionNotFoundError(sessionId));
    }

    if (this.syncUsecase) {
      await this.syncUsecase.ensureSessionWatching(sessionId);
    }

    const storedAgents = this.repo.getAgents(sessionId);
    const mainRecord = buildMainAgentRecord(
      session,
      storedAgents.find((a) => a.agentId === "main"),
    );
    const subagents = storedAgents
      .filter((a) => a.agentId !== "main")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const tasks = this.repo.getTasks(sessionId);

    return ok({
      sessionId,
      agents: [mainRecord, ...subagents].map(toAgentNodeContract),
      tasks: tasks.map(toTeamTaskContract),
    });
  }

  listAll(): AllAgentsResponse {
    const ids = this.sessions.listSessionIds?.() ?? [];
    const bySession: Record<string, AgentNode[]> = {};
    for (const id of ids) {
      const stored = this.repo
        .getAgents(id)
        .filter((a) => a.agentId !== "main")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      if (stored.length > 0) {
        bySession[id] = stored.map(toAgentNodeContract);
      }
    }
    return { bySession };
  }
}
