import type { AppError } from "@core/errors";
import { err, ok, type Result } from "@core/result";
import type { AgentsRepository } from "../domain/agents.repository.port.ts";
import { AgentNotFoundError, AgentSessionNotFoundError } from "../domain/errors.ts";
import type {
  AgentEventPublisherPort,
  AgentTranscriptEvent,
  AgentTranscriptWatcherPort,
  SessionAgentLookupPort,
} from "./ports.ts";
import { buildMainAgentRecord, type SyncAgentTelemetryUsecase } from "./sync-agent-telemetry.usecase.ts";

export interface StreamAgentEventsOutput {
  agent: ReturnType<typeof buildMainAgentRecord>;
  replayEvents: AgentTranscriptEvent[];
  subscribe: (handler: (event: AgentTranscriptEvent) => void) => () => void;
}

export class StreamAgentEventsUsecase {
  constructor(
    private readonly sessions: SessionAgentLookupPort,
    private readonly repo: AgentsRepository,
    private readonly watcher: AgentTranscriptWatcherPort,
    private readonly publisher: AgentEventPublisherPort,
    private readonly syncUsecase?: SyncAgentTelemetryUsecase,
  ) {}

  async execute(
    sessionId: string,
    agentId: string,
  ): Promise<Result<StreamAgentEventsOutput, AppError>> {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      return err(new AgentSessionNotFoundError(sessionId));
    }

    if (this.syncUsecase) {
      await this.syncUsecase.ensureSessionWatching(sessionId);
    }

    const stored = this.repo.getAgents(sessionId);
    const agent =
      agentId === "main"
        ? buildMainAgentRecord(
            session,
            stored.find((a) => a.agentId === "main"),
          )
        : stored.find((a) => a.agentId === agentId);

    if (!agent) {
      return err(new AgentNotFoundError(sessionId, agentId));
    }

    let replayEvents: AgentTranscriptEvent[] = [];
    if (agent.transcriptPath) {
      replayEvents = await this.watcher.readRecentEvents(agent.transcriptPath).catch(() => []);
    } else if (agentId !== "main" && session.transcriptPath) {
      const mainEvents = await this.watcher.readRecentEvents(session.transcriptPath).catch(() => []);
      replayEvents = mainEvents.filter((ev) => ev.parentToolUseId === agentId);
    }

    if (replayEvents.length === 0) {
      replayEvents = this.publisher.getRecentAgentStreamEvents(sessionId, agentId);
    }

    return ok({
      agent,
      replayEvents,
      subscribe: (handler) => this.publisher.subscribeAgentStream(sessionId, agentId, handler),
    });
  }
}
