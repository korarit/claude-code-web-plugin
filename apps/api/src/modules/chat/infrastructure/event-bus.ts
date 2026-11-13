import type { DomainChatEvent, SessionListEvent } from "../domain/chat.events.ts";
import type { EventBusPort } from "../application/ports.ts";

const MAX_RECENT_EVENTS = 200;

export class InMemoryEventBus implements EventBusPort {
  private readonly sessionSubscribers = new Map<string, Set<(event: DomainChatEvent) => void>>();
  private readonly recentEvents = new Map<string, DomainChatEvent[]>();
  private readonly listSubscribers = new Set<(event: SessionListEvent) => void>();

  publish(sessionId: string, event: DomainChatEvent): void {
    const history = this.recentEvents.get(sessionId) ?? [];
    history.push(event);
    if (history.length > MAX_RECENT_EVENTS) {
      history.splice(0, history.length - MAX_RECENT_EVENTS);
    }
    this.recentEvents.set(sessionId, history);

    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs) return;
    for (const handler of subs) {
      handler(event);
    }
  }

  subscribe(sessionId: string, handler: (event: DomainChatEvent) => void): () => void {
    let subs = this.sessionSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.sessionSubscribers.set(sessionId, subs);
    }
    subs.add(handler);
    return () => {
      const current = this.sessionSubscribers.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.sessionSubscribers.delete(sessionId);
      }
    };
  }

  getRecentEvents(sessionId: string): DomainChatEvent[] {
    return [...(this.recentEvents.get(sessionId) ?? [])];
  }

  clearSession(sessionId: string): void {
    this.recentEvents.delete(sessionId);
    this.sessionSubscribers.delete(sessionId);
  }

  publishListEvent(event: SessionListEvent): void {
    for (const handler of this.listSubscribers) {
      handler(event);
    }
  }

  subscribeListEvents(handler: (event: SessionListEvent) => void): () => void {
    this.listSubscribers.add(handler);
    return () => {
      this.listSubscribers.delete(handler);
    };
  }
}
