import type {
  DiscoveredExternalSession,
  HarnessDescriptor,
  HarnessId,
} from "@contracts/harness";
import { UnknownHarnessError } from "../domain/errors.ts";
import type { HarnessAdapter } from "../domain/harness.port.ts";

export class HarnessRegistry {
  private readonly adapters = new Map<HarnessId, HarnessAdapter>();

  constructor(initial: HarnessAdapter[] = []) {
    for (const adapter of initial) {
      this.register(adapter);
    }
  }

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  has(id: string): id is HarnessId {
    return this.adapters.has(id as HarnessId);
  }

  get(id: HarnessId): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new UnknownHarnessError(id);
    }
    return adapter;
  }

  find(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id as HarnessId);
  }

  list(): HarnessAdapter[] {
    return [...this.adapters.values()];
  }

  async getDescriptors(): Promise<HarnessDescriptor[]> {
    const descriptors = await Promise.all(
      this.list().map(async (adapter): Promise<HarnessDescriptor> => {
        const available = await adapter.detectAvailability().catch(() => false);
        const [models, agentProfiles] = await Promise.all([
          adapter.listModels().catch(() => [adapter.getDefaultModel()]),
          adapter.listAgentProfiles ? adapter.listAgentProfiles().catch(() => []) : Promise.resolve([]),
        ]);
        return {
          id: adapter.id,
          name: adapter.name,
          binary: adapter.binary,
          available,
          models: models.length > 0 ? models : [adapter.getDefaultModel()],
          defaultModel: adapter.getDefaultModel(),
          agentProfiles: agentProfiles.length > 0 ? agentProfiles : undefined,
          capabilities: adapter.capabilities,
        };
      }),
    );
    return descriptors;
  }

  async discoverAll(): Promise<DiscoveredExternalSession[]> {
    const results = await Promise.all(
      this.list().map((adapter) => adapter.discoverSessions().catch(() => [])),
    );
    return results.flat();
  }

  watchAll(onUpsert: (session: DiscoveredExternalSession) => void): () => void {
    const unsubs: Array<() => void> = [];
    for (const adapter of this.list()) {
      if (adapter.watchExternalSessions) {
        unsubs.push(adapter.watchExternalSessions(onUpsert));
      }
    }
    return () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Ignore watcher cleanup failures.
        }
      }
    };
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.list().map((adapter) => Promise.resolve(adapter.dispose?.()).catch(() => {})),
    );
  }
}
