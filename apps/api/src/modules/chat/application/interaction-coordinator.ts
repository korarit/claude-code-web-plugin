import type { PendingInteraction, PermissionDecision } from "@contracts/chat";

interface PermissionWaiter {
  interactionId: string;
  sessionId: string;
  resolve: (decision: PermissionDecision | "timeout") => void;
  timer: ReturnType<typeof setTimeout>;
}

export class InteractionCoordinator {
  private readonly pendingBySession = new Map<string, PendingInteraction>();
  private readonly waitersBySession = new Map<string, PermissionWaiter>();

  getPending(sessionId: string): PendingInteraction | null {
    return this.pendingBySession.get(sessionId) ?? null;
  }

  setPending(sessionId: string, interaction: PendingInteraction): void {
    this.pendingBySession.set(sessionId, interaction);
  }

  waitForPermissionDecision(
    sessionId: string,
    interaction: PendingInteraction,
    timeoutMs = 55_000,
  ): Promise<PermissionDecision | "timeout"> {
    this.cancelWaiter(sessionId);
    this.pendingBySession.set(sessionId, interaction);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = this.waitersBySession.get(sessionId);
        if (current && current.interactionId === interaction.id) {
          this.waitersBySession.delete(sessionId);
        }
        resolve("timeout");
      }, timeoutMs);

      this.waitersBySession.set(sessionId, {
        interactionId: interaction.id,
        sessionId,
        resolve,
        timer,
      });
    });
  }

  resolvePermission(
    sessionId: string,
    decision: PermissionDecision,
    interactionId?: string,
  ): { resolved: boolean; interactionId?: string } {
    const waiter = this.waitersBySession.get(sessionId);
    const pending = this.pendingBySession.get(sessionId);

    if (interactionId && waiter && waiter.interactionId !== interactionId) {
      return { resolved: false };
    }
    if (interactionId && !waiter && pending && pending.id !== interactionId) {
      return { resolved: false };
    }

    if (waiter) {
      clearTimeout(waiter.timer);
      this.waitersBySession.delete(sessionId);
      if (pending?.id === waiter.interactionId) {
        this.pendingBySession.delete(sessionId);
      }
      waiter.resolve(decision);
      return { resolved: true, interactionId: waiter.interactionId };
    }

    return { resolved: false };
  }

  clearPending(sessionId: string, interactionId?: string): PendingInteraction | null {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) return null;
    if (interactionId && pending.id !== interactionId) return null;

    this.cancelWaiter(sessionId);
    this.pendingBySession.delete(sessionId);
    return pending;
  }

  cancelSession(sessionId: string): void {
    this.cancelWaiter(sessionId);
    this.pendingBySession.delete(sessionId);
  }

  private cancelWaiter(sessionId: string): void {
    const waiter = this.waitersBySession.get(sessionId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waitersBySession.delete(sessionId);
    waiter.resolve("timeout");
  }
}
