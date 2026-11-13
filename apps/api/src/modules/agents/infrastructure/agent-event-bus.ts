import type { AgentNodeRecord, TeamTaskRecord } from "../domain/agent-node.entity.ts";
import type { AgentEventPublisherPort, AgentTranscriptEvent } from "../application/ports.ts";

const MAX_AGENT_STREAM_EVENTS = 250;

export interface SessionAgentEventBridge {
  publishAgentUpdated(sessionId: string, agent: AgentNodeRecord): void;
  publishTasksUpdated(sessionId: string, tasks: TeamTaskRecord[]): void;
}

export class InMemoryAgentEventBus implements AgentEventPublisherPort {
  private readonly streamSubscribers = new Map<
    string,
    Set<(event: AgentTranscriptEvent) => void>
  >();
  private readonly recentEvents = new Map<string, AgentTranscriptEvent[]>();

  constructor(private readonly sessionBridge: SessionAgentEventBridge) {}

  publishAgentUpdated(sessionId: string, agent: AgentNodeRecord): void {
    this.sessionBridge.publishAgentUpdated(sessionId, agent);
    const subs = this.streamSubscribers.get(this.key(sessionId, agent.agentId));
    if (subs) {
      const ev: AgentTranscriptEvent = {
        type: "agent_updated",
        agentRecord: agent,
        timestamp: agent.updatedAt,
      };
      for (const handler of subs) {
        handler(ev);
      }
    }
  }

  publishTasksUpdated(sessionId: string, tasks: TeamTaskRecord[]): void {
    this.sessionBridge.publishTasksUpdated(sessionId, tasks);
  }

  publishAgentStreamEvent(sessionId: string, agentId: string, event: AgentTranscriptEvent): void {
    const key = this.key(sessionId, agentId);
    const history = this.recentEvents.get(key) ?? [];
    history.push(event);
    if (history.length > MAX_AGENT_STREAM_EVENTS) {
      history.splice(0, history.length - MAX_AGENT_STREAM_EVENTS);
    }
    this.recentEvents.set(key, history);

    const subs = this.streamSubscribers.get(key);
    if (!subs) return;
    for (const handler of subs) {
      handler(event);
    }
  }

  subscribeAgentStream(
    sessionId: string,
    agentId: string,
    handler: (event: AgentTranscriptEvent) => void,
  ): () => void {
    const key = this.key(sessionId, agentId);
    let subs = this.streamSubscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.streamSubscribers.set(key, subs);
    }
    subs.add(handler);
    return () => {
      const current = this.streamSubscribers.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.streamSubscribers.delete(key);
      }
    };
  }

  getRecentAgentStreamEvents(sessionId: string, agentId: string): AgentTranscriptEvent[] {
    return [...(this.recentEvents.get(this.key(sessionId, agentId)) ?? [])];
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of [...this.recentEvents.keys()]) {
      if (key.startsWith(prefix)) this.recentEvents.delete(key);
    }
    for (const key of [...this.streamSubscribers.keys()]) {
      if (key.startsWith(prefix)) this.streamSubscribers.delete(key);
    }
  }

  private key(sessionId: string, agentId: string): string {
    return `${sessionId}::${agentId}`;
  }
}
