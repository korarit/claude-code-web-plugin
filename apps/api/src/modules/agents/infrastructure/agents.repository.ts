import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeJsonParse } from "@core/utils";
import type { AgentNodeRecord, TeamTaskRecord } from "../domain/agent-node.entity.ts";
import type { AgentsRepository } from "../domain/agents.repository.port.ts";

interface PersistedSessionAgents {
  agents: AgentNodeRecord[];
  tasks: TeamTaskRecord[];
}

export class FileAgentsRepository implements AgentsRepository {
  private readonly cache = new Map<string, PersistedSessionAgents>();

  constructor(private readonly baseDir: string) {}

  getAgents(sessionId: string): AgentNodeRecord[] {
    return [...this.load(sessionId).agents];
  }

  saveAgents(sessionId: string, agents: AgentNodeRecord[]): void {
    const state = this.load(sessionId);
    const next: PersistedSessionAgents = {
      agents: [...agents],
      tasks: state.tasks,
    };
    this.save(sessionId, next);
  }

  getTasks(sessionId: string): TeamTaskRecord[] {
    return [...this.load(sessionId).tasks];
  }

  saveTasks(sessionId: string, tasks: TeamTaskRecord[]): void {
    const state = this.load(sessionId);
    const next: PersistedSessionAgents = {
      agents: state.agents,
      tasks: [...tasks],
    };
    this.save(sessionId, next);
  }

  deleteSession(sessionId: string): void {
    this.cache.delete(sessionId);
    const file = this.filePath(sessionId);
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }

  private filePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.baseDir, `${safeId}.json`);
  }

  private load(sessionId: string): PersistedSessionAgents {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const file = this.filePath(sessionId);
    if (!existsSync(file)) {
      const empty: PersistedSessionAgents = { agents: [], tasks: [] };
      this.cache.set(sessionId, empty);
      return empty;
    }

    try {
      const raw = readFileSync(file, "utf8");
      const parsed = safeJsonParse<Partial<PersistedSessionAgents>>(raw);
      const loaded: PersistedSessionAgents = {
        agents: Array.isArray(parsed?.agents) ? parsed.agents : [],
        tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
      };
      this.cache.set(sessionId, loaded);
      return loaded;
    } catch {
      const empty: PersistedSessionAgents = { agents: [], tasks: [] };
      this.cache.set(sessionId, empty);
      return empty;
    }
  }

  private save(sessionId: string, state: PersistedSessionAgents): void {
    this.cache.set(sessionId, state);
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath(sessionId), JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
