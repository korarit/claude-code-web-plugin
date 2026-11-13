import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeJsonParse } from "@core/utils";
import { normalizeTaskStatus, type TeamTaskRecord } from "../domain/agent-node.entity.ts";
import type { AgentTeamTasksWatcherPort } from "../application/ports.ts";

interface WatchEntry {
  watchers: FSWatcher[];
  pollTimer?: ReturnType<typeof setInterval>;
}

interface RawClaudeTask {
  id?: string | number;
  subject?: string;
  title?: string;
  description?: string;
  owner?: string;
  assignee?: string;
  status?: string;
  updatedAt?: string;
}

export class ClaudeTeamTasksWatcher implements AgentTeamTasksWatcherPort {
  private readonly activeWatches = new Map<string, WatchEntry>();

  constructor(private readonly claudeHome: string) {}

  async readTeamTasks(sessionId: string, externalSessionId?: string): Promise<TeamTaskRecord[]> {
    const tasksRoot = join(this.claudeHome, "tasks");
    if (!existsSync(tasksRoot)) return [];

    const candidateDirs = await this.resolveTaskDirs(tasksRoot, sessionId, externalSessionId);
    const items: TeamTaskRecord[] = [];
    const seen = new Set<string>();

    for (const dir of candidateDirs) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      const jsonFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

      for (const fileName of jsonFiles) {
        const fullPath = join(dir, fileName);
        try {
          const raw = await readFile(fullPath, "utf8");
          const parsed = safeJsonParse<RawClaudeTask | RawClaudeTask[]>(raw);
          const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
          for (const item of list) {
            const subject =
              typeof item.subject === "string" && item.subject.trim()
                ? item.subject.trim()
                : typeof item.title === "string" && item.title.trim()
                  ? item.title.trim()
                  : "";
            if (!subject) continue;

            const id =
              item.id !== undefined && String(item.id).trim()
                ? String(item.id).trim()
                : fileName.replace(/\.json$/, "");
            if (seen.has(id)) continue;
            seen.add(id);

            items.push({
              id,
              subject,
              description: typeof item.description === "string" ? item.description : undefined,
              owner:
                typeof item.owner === "string" && item.owner.trim()
                  ? item.owner.trim()
                  : typeof item.assignee === "string" && item.assignee.trim()
                    ? item.assignee.trim()
                    : undefined,
              status: normalizeTaskStatus(item.status),
              source: "team_task",
              updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
            });
          }
        } catch {
          // Ignore malformed/in-flight task JSON files.
        }
      }
    }

    return items;
  }

  watchTeamTasks(
    sessionId: string,
    externalSessionId: string | undefined,
    onChange: () => void,
  ): void {
    this.unwatchTeamTasks(sessionId);

    const entry: WatchEntry = { watchers: [] };
    const tasksRoot = join(this.claudeHome, "tasks");
    if (existsSync(tasksRoot)) {
      try {
        entry.watchers.push(
          watch(tasksRoot, { recursive: false }, () => {
            onChange();
          }),
        );
      } catch {
        // Ignore watch errors; polling fallback stays active.
      }
    }

    for (const id of [sessionId, externalSessionId].filter((v): v is string => Boolean(v))) {
      const subDir = join(tasksRoot, id);
      if (existsSync(subDir)) {
        try {
          entry.watchers.push(
            watch(subDir, () => {
              onChange();
            }),
          );
        } catch {
          // Ignore watch errors.
        }
      }
    }

    entry.pollTimer = setInterval(onChange, 1500);
    this.activeWatches.set(sessionId, entry);
  }

  unwatchTeamTasks(sessionId: string): void {
    const entry = this.activeWatches.get(sessionId);
    if (!entry) return;
    for (const w of entry.watchers) {
      w.close();
    }
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    this.activeWatches.delete(sessionId);
  }

  private async resolveTaskDirs(
    tasksRoot: string,
    sessionId: string,
    externalSessionId?: string,
  ): Promise<string[]> {
    const dirs: string[] = [];
    const candidates = new Set<string>([sessionId]);
    if (externalSessionId) candidates.add(externalSessionId);

    // Also inspect ~/.claude/teams/*/config.json for leadSessionId matches.
    const teamsRoot = join(this.claudeHome, "teams");
    if (existsSync(teamsRoot)) {
      try {
        const teamDirs = readdirSync(teamsRoot, { withFileTypes: true });
        for (const td of teamDirs) {
          if (!td.isDirectory()) continue;
          const configPath = join(teamsRoot, td.name, "config.json");
          if (!existsSync(configPath)) continue;
          const raw = await readFile(configPath, "utf8").catch(() => "");
          const cfg = safeJsonParse<{ leadSessionId?: string; teamName?: string }>(raw);
          if (
            cfg?.leadSessionId &&
            (cfg.leadSessionId === sessionId || cfg.leadSessionId === externalSessionId)
          ) {
            candidates.add(td.name);
            if (cfg.teamName) candidates.add(cfg.teamName);
          }
        }
      } catch {
        // Ignore teams scan failure.
      }
    }

    for (const name of candidates) {
      const dir = join(tasksRoot, name);
      if (existsSync(dir)) {
        dirs.push(dir);
      }
    }
    return dirs;
  }
}
