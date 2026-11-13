import { isoNow, systemClock, type Clock } from "@core/time";
import {
  appendAgentLog,
  deriveActivityFromTool,
  extractSubagentMeta,
  mapTodoWriteToTasks,
  mergeTaskLists,
  normalizeTaskStatus,
  type AgentActivityState,
  type AgentNodeRecord,
  type TeamTaskRecord,
} from "../domain/agent-node.entity.ts";
import type { AgentsRepository } from "../domain/agents.repository.port.ts";
import type {
  AgentEventPublisherPort,
  AgentFileChangeTrackerPort,
  AgentHookInput,
  AgentTeamTasksWatcherPort,
  AgentTranscriptEvent,
  AgentTranscriptWatcherPort,
  SessionAgentInfo,
  SessionAgentLookupPort,
} from "./ports.ts";

const EDIT_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function mapSessionStatusToAgentState(status: string): AgentActivityState {
  switch (status) {
    case "running":
      return "thinking";
    case "waiting_permission":
      return "waiting";
    case "stopped":
      return "done";
    default:
      return "idle";
  }
}

export function buildMainAgentRecord(
  session: SessionAgentInfo,
  existing?: AgentNodeRecord,
): AgentNodeRecord {
  const mappedState = mapSessionStatusToAgentState(session.status);
  // Preserve specific running sub-activity (reading/editing/running_cmd) while session is running.
  const state =
    session.status === "running" &&
    existing &&
    (existing.state === "reading" ||
      existing.state === "editing" ||
      existing.state === "running_cmd" ||
      existing.state === "thinking")
      ? existing.state
      : mappedState;

  return {
    agentId: "main",
    role: "Main Agent",
    agentType: session.harnessId,
    transcriptPath: session.transcriptPath ?? existing?.transcriptPath,
    canSendInput: true,
    state,
    currentTool:
      state === "idle" || state === "done" ? undefined : existing?.currentTool,
    currentTarget:
      state === "idle" || state === "done" ? undefined : existing?.currentTarget,
    usage: existing?.usage,
    recentLogs: existing?.recentLogs ?? [],
    startedAt: existing?.startedAt ?? session.updatedAt,
    updatedAt: existing?.updatedAt ?? session.updatedAt,
  };
}

export class SyncAgentTelemetryUsecase {
  private readonly watchedTeamSessions = new Set<string>();
  private readonly watchedAgentTranscripts = new Set<string>();

  constructor(
    private readonly repo: AgentsRepository,
    private readonly sessions: SessionAgentLookupPort,
    private readonly watcher: AgentTranscriptWatcherPort,
    private readonly teamTasksWatcher: AgentTeamTasksWatcherPort,
    private readonly publisher: AgentEventPublisherPort,
    private readonly clock: Clock = systemClock,
    private readonly fileChangeTracker?: AgentFileChangeTrackerPort,
  ) {}

  async ensureSessionWatching(sessionId: string): Promise<void> {
    const session = this.sessions.getSession(sessionId);
    if (!session) return;

    if (!this.watchedTeamSessions.has(sessionId)) {
      this.watchedTeamSessions.add(sessionId);
      this.teamTasksWatcher.watchTeamTasks(sessionId, session.externalSessionId, () => {
        void this.syncTeamTasksFromDisk(sessionId);
      });
    }

    // Re-attach watchers for any persisted subagent transcripts.
    const existingAgents = this.repo.getAgents(sessionId);
    for (const agent of existingAgents) {
      if (agent.agentId !== "main" && agent.transcriptPath && agent.state !== "done") {
        await this.ensureAgentTranscriptWatch(sessionId, agent.agentId, agent.transcriptPath);
      }
    }

    await this.syncTeamTasksFromDisk(sessionId);
  }

  async onHookEvent(input: AgentHookInput): Promise<void> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) return;
    await this.ensureSessionWatching(input.sessionId);

    const now = input.timestamp ?? isoNow(this.clock);
    const eventName = input.hookEventName;

    if (eventName === "SubagentStart") {
      const agentId = input.agentId?.trim();
      if (!agentId) return;
      const role = input.agentType?.trim() || `Subagent (${agentId.slice(0, 8)})`;
      const prev = this.findAgent(input.sessionId, agentId);
      const next: AgentNodeRecord = {
        agentId,
        parentAgentId: "main",
        role: prev?.role && prev.role !== "Subagent" ? prev.role : role,
        agentType: input.agentType?.trim() || prev?.agentType,
        transcriptPath: input.agentTranscriptPath || prev?.transcriptPath,
        canSendInput: false,
        state: "thinking",
        currentTool: prev?.currentTool,
        currentTarget: prev?.currentTarget,
        usage: prev?.usage,
        recentLogs: appendAgentLog(prev?.recentLogs ?? [], `Started ${role}`),
        startedAt: prev?.startedAt ?? now,
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);

      if (next.transcriptPath) {
        await this.ensureAgentTranscriptWatch(input.sessionId, agentId, next.transcriptPath);
      }
      return;
    }

    if (eventName === "SubagentStop") {
      const agentId = input.agentId?.trim();
      if (!agentId) return;
      const prev = this.findAgent(input.sessionId, agentId);
      const next: AgentNodeRecord = {
        agentId,
        parentAgentId: "main",
        role: prev?.role ?? (input.agentType?.trim() || `Subagent (${agentId.slice(0, 8)})`),
        agentType: input.agentType?.trim() || prev?.agentType,
        transcriptPath: input.agentTranscriptPath || prev?.transcriptPath,
        canSendInput: false,
        state: "done",
        currentTool: undefined,
        currentTarget: undefined,
        usage: prev?.usage,
        recentLogs: appendAgentLog(prev?.recentLogs ?? [], "Completed"),
        startedAt: prev?.startedAt ?? now,
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
      return;
    }

    if (eventName === "TeammateIdle") {
      const agents = this.ensureMainAgentInList(session, this.repo.getAgents(input.sessionId));
      const target = agents.find(
        (a) =>
          (input.agentId && a.agentId === input.agentId) ||
          (input.teammateName &&
            (a.agentId === input.teammateName ||
              a.role.toLowerCase() === input.teammateName.toLowerCase())),
      );
      if (target) {
        const next: AgentNodeRecord = {
          ...target,
          state: "idle",
          currentTool: undefined,
          currentTarget: undefined,
          recentLogs: appendAgentLog(target.recentLogs, "Idle"),
          updatedAt: now,
        };
        this.saveAgent(input.sessionId, next);
        this.publisher.publishAgentUpdated(input.sessionId, next);
      }
      return;
    }

    if (eventName === "TaskCreated" || eventName === "TaskCompleted") {
      const status = eventName === "TaskCompleted" ? "completed" : normalizeTaskStatus(input.taskStatus);
      const existingTasks = this.repo.getTasks(input.sessionId);
      if (input.taskId || input.taskSubject) {
        const id = input.taskId?.trim() || `hook-${input.taskSubject?.slice(0, 24) ?? "task"}`;
        const idx = existingTasks.findIndex((t) => t.id === id);
        const prev = idx >= 0 ? existingTasks[idx]! : undefined;
        const item: TeamTaskRecord = {
          id,
          subject: input.taskSubject?.trim() || prev?.subject || `Task ${id}`,
          description: prev?.description,
          owner: input.teammateName?.trim() || input.agentId?.trim() || prev?.owner,
          status,
          source: "team_task",
          updatedAt: now,
        };
        const updated =
          idx >= 0
            ? existingTasks.map((t, i) => (i === idx ? item : t))
            : [...existingTasks, item];
        this.repo.saveTasks(input.sessionId, updated);
        this.publisher.publishTasksUpdated(input.sessionId, updated);
      }
      await this.syncTeamTasksFromDisk(input.sessionId);
      return;
    }

    const targetAgentId = input.agentId?.trim() || "main";
    if (eventName === "PreToolUse" && input.toolName) {
      const prev =
        targetAgentId === "main"
          ? buildMainAgentRecord(session, this.findAgent(input.sessionId, "main"))
          : this.findAgent(input.sessionId, targetAgentId);
      if (!prev) return;
      const activity = deriveActivityFromTool(input.toolName, input.toolInput);
      const next: AgentNodeRecord = {
        ...prev,
        state: activity.state,
        currentTool: input.toolName,
        currentTarget: activity.target,
        recentLogs: appendAgentLog(
          prev.recentLogs,
          activity.target ? `${input.toolName}: ${activity.target}` : input.toolName,
        ),
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
      return;
    }

    if (eventName === "PostToolUse" && input.toolName) {
      if (input.toolName === "TodoWrite") {
        const mapped = mapTodoWriteToTasks(input.toolInput, now);
        if (mapped) {
          await this.mergeAndSaveTodoTasks(input.sessionId, mapped);
        }
      }
      const prev =
        targetAgentId === "main"
          ? buildMainAgentRecord(session, this.findAgent(input.sessionId, "main"))
          : this.findAgent(input.sessionId, targetAgentId);
      if (!prev) return;
      const next: AgentNodeRecord = {
        ...prev,
        state: "thinking",
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
      return;
    }

    if (eventName === "Stop" || eventName === "SessionEnd") {
      const mainPrev = buildMainAgentRecord(session, this.findAgent(input.sessionId, "main"));
      const next: AgentNodeRecord = {
        ...mainPrev,
        state: eventName === "SessionEnd" ? "done" : "idle",
        currentTool: undefined,
        currentTarget: undefined,
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
      return;
    }

    if (eventName === "PermissionRequest") {
      const prev =
        targetAgentId === "main"
          ? buildMainAgentRecord(session, this.findAgent(input.sessionId, "main"))
          : this.findAgent(input.sessionId, targetAgentId);
      if (!prev) return;
      const activity = input.toolName
        ? deriveActivityFromTool(input.toolName, input.toolInput)
        : undefined;
      const next: AgentNodeRecord = {
        ...prev,
        state: "waiting",
        currentTool: input.toolName ?? prev.currentTool,
        currentTarget: activity?.target ?? prev.currentTarget,
        recentLogs: appendAgentLog(
          prev.recentLogs,
          input.toolName ? `Waiting approval: ${input.toolName}` : "Waiting approval",
        ),
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
      return;
    }

    if (eventName === "PermissionResolved" || eventName === "UserPromptSubmit") {
      const prev =
        targetAgentId === "main"
          ? buildMainAgentRecord(session, this.findAgent(input.sessionId, "main"))
          : this.findAgent(input.sessionId, targetAgentId);
      if (!prev) return;
      const next: AgentNodeRecord = {
        ...prev,
        state: "thinking",
        updatedAt: now,
      };
      this.saveAgent(input.sessionId, next);
      this.publisher.publishAgentUpdated(input.sessionId, next);
    }
  }

  async onMainTranscriptEvent(sessionId: string, event: AgentTranscriptEvent): Promise<void> {
    const session = this.sessions.getSession(sessionId);
    if (!session) return;
    const now = event.timestamp ?? isoNow(this.clock);

    // Handle TodoWrite in transcript.
    if (event.tool === "TodoWrite" && event.toolInput) {
      const mapped = mapTodoWriteToTasks(event.toolInput, now);
      if (mapped) {
        await this.mergeAndSaveTodoTasks(sessionId, mapped);
      }
    }

    // Handle Task / Agent subagent spawn from main transcript.
    if ((event.tool === "Task" || event.tool === "Agent") && event.toolUseId) {
      const existing = this.findAgent(sessionId, event.toolUseId);
      const meta = extractSubagentMeta(event.tool, event.toolInput);
      const next: AgentNodeRecord = {
        agentId: event.toolUseId,
        parentAgentId: "main",
        role: existing?.role ?? meta.role,
        agentType: existing?.agentType ?? meta.agentType,
        transcriptPath: existing?.transcriptPath,
        canSendInput: false,
        state: existing?.state === "done" ? "done" : "thinking",
        currentTool: existing?.currentTool,
        currentTarget: existing?.currentTarget,
        usage: existing?.usage,
        recentLogs: existing?.recentLogs ?? [`Spawned: ${meta.role}`],
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
      };
      this.saveAgent(sessionId, next);
      this.publisher.publishAgentUpdated(sessionId, next);
      return;
    }

    // Subagent tool_result back on main transcript marks toolUseId subagent done.
    if (event.tool === "tool_result" && event.toolUseId) {
      const child = this.findAgent(sessionId, event.toolUseId);
      if (child && child.state !== "done") {
        const next: AgentNodeRecord = {
          ...child,
          state: "done",
          currentTool: undefined,
          currentTarget: undefined,
          recentLogs: appendAgentLog(child.recentLogs, "Finished"),
          updatedAt: now,
        };
        this.saveAgent(sessionId, next);
        this.publisher.publishAgentUpdated(sessionId, next);
      }
    }

    // Route progress / nested events with parentToolUseId to the child agent (if not already tailed via its own transcript).
    if (event.parentToolUseId) {
      const child = this.findAgent(sessionId, event.parentToolUseId);
      if (child && !child.transcriptPath) {
        this.applyEventToAgent(sessionId, child, event, now);
        this.publisher.publishAgentStreamEvent(sessionId, child.agentId, event);
      }
      return;
    }

    // Update Main Agent state/usage.
    const main = buildMainAgentRecord(session, this.findAgent(sessionId, "main"));
    this.applyEventToAgent(sessionId, main, event, now);
  }

  async syncTeamTasksFromDisk(sessionId: string): Promise<void> {
    const session = this.sessions.getSession(sessionId);
    if (!session) return;
    const diskTasks = await this.teamTasksWatcher
      .readTeamTasks(sessionId, session.externalSessionId)
      .catch(() => []);
    const existing = this.repo.getTasks(sessionId);
    const todoTasks = existing.filter((t) => t.source === "todo");
    const diskById = new Map(diskTasks.map((t) => [t.id, t]));
    const retainedHookTasks = existing.filter(
      (t) => t.source === "team_task" && !diskById.has(t.id),
    );
    const merged = mergeTaskLists(todoTasks, [...retainedHookTasks, ...diskTasks]);

    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      this.repo.saveTasks(sessionId, merged);
      this.publisher.publishTasksUpdated(sessionId, merged);
    }
  }

  deleteSession(sessionId: string): void {
    this.teamTasksWatcher.unwatchTeamTasks(sessionId);
    this.watchedTeamSessions.delete(sessionId);
    const prefix = `${sessionId}::agent::`;
    for (const key of [...this.watchedAgentTranscripts]) {
      if (key.startsWith(prefix)) {
        this.watcher.unwatch(key);
        this.watchedAgentTranscripts.delete(key);
      }
    }
    this.repo.deleteSession(sessionId);
    this.publisher.clearSession(sessionId);
  }

  private async ensureAgentTranscriptWatch(
    sessionId: string,
    agentId: string,
    transcriptPath: string,
  ): Promise<void> {
    const watchKey = `${sessionId}::agent::${agentId}`;
    if (this.watchedAgentTranscripts.has(watchKey)) return;
    this.watchedAgentTranscripts.add(watchKey);
    const trackedTools = new Map<string, { toolName: string; toolInput?: unknown; model?: string }>();

    await this.watcher.watchFromStart(watchKey, transcriptPath, (event) => {
      const current = this.findAgent(sessionId, agentId);
      if (!current) return;
      const session = this.sessions.getSession(sessionId);
      const now = event.timestamp ?? isoNow(this.clock);

      if (
        this.fileChangeTracker &&
        session?.cwd &&
        event.type === "tool" &&
        event.tool &&
        EDIT_CHANGE_TOOLS.has(event.tool) &&
        event.toolUseId
      ) {
        trackedTools.set(event.toolUseId, {
          toolName: event.tool,
          toolInput: event.toolInput,
          model: event.model,
        });
        void this.fileChangeTracker.onPreToolUse({
          sessionId,
          cwd: session.cwd,
          harnessId: session.harnessId,
          model: event.model ?? session.model,
          toolName: event.tool,
          toolUseId: event.toolUseId,
          toolInput: event.toolInput,
          agentId,
        });
      }

      if (
        this.fileChangeTracker &&
        session?.cwd &&
        event.type === "tool" &&
        event.tool === "tool_result" &&
        event.toolUseId
      ) {
        const meta = trackedTools.get(event.toolUseId);
        if (meta) {
          trackedTools.delete(event.toolUseId);
          void this.fileChangeTracker.onPostToolUse({
            sessionId,
            cwd: session.cwd,
            harnessId: session.harnessId,
            model: meta.model ?? session.model,
            toolName: meta.toolName,
            toolUseId: event.toolUseId,
            toolInput: meta.toolInput,
            agentId,
            editedAt: event.timestamp,
          });
        }
      }

      this.applyEventToAgent(sessionId, current, event, now);
      this.publisher.publishAgentStreamEvent(sessionId, agentId, event);
    });
  }

  private applyEventToAgent(
    sessionId: string,
    agent: AgentNodeRecord,
    event: AgentTranscriptEvent,
    now: string,
  ): void {
    let changed = false;
    let next: AgentNodeRecord = { ...agent };

    if (event.type === "tool" && event.tool && event.tool !== "tool_result") {
      const activity = deriveActivityFromTool(event.tool, event.toolInput);
      next = {
        ...next,
        state: next.state === "done" ? "done" : activity.state,
        currentTool: event.tool,
        currentTarget: activity.target,
        recentLogs: appendAgentLog(
          next.recentLogs,
          activity.target ? `${event.tool}: ${activity.target}` : event.tool,
        ),
        updatedAt: now,
      };
      changed = true;
    } else if (event.type === "tool" && event.tool === "tool_result") {
      if (next.state !== "done") {
        next = {
          ...next,
          state: "thinking",
          updatedAt: now,
        };
        changed = true;
      }
    } else if (event.type === "delta" && event.text) {
      next = {
        ...next,
        state: next.state === "done" ? "done" : "thinking",
        recentLogs: appendAgentLog(next.recentLogs, event.text),
        updatedAt: now,
      };
      changed = true;
    } else if (event.type === "interaction") {
      next = {
        ...next,
        state: "waiting",
        updatedAt: now,
      };
      changed = true;
    }

    if (event.usage) {
      next = {
        ...next,
        usage: {
          inputTokens: event.usage.inputTokens ?? next.usage?.inputTokens,
          outputTokens: event.usage.outputTokens ?? next.usage?.outputTokens,
          contextWindow: event.usage.contextWindow ?? next.usage?.contextWindow,
        },
        updatedAt: now,
      };
      changed = true;
    }

    if (changed) {
      this.saveAgent(sessionId, next);
      this.publisher.publishAgentUpdated(sessionId, next);
    }
  }

  private async mergeAndSaveTodoTasks(sessionId: string, todoTasks: TeamTaskRecord[]): Promise<void> {
    const existing = this.repo.getTasks(sessionId);
    const diskTasks = existing.filter((t) => t.source === "team_task");
    const merged = mergeTaskLists(todoTasks, diskTasks);
    this.repo.saveTasks(sessionId, merged);
    this.publisher.publishTasksUpdated(sessionId, merged);
  }

  private findAgent(sessionId: string, agentId: string): AgentNodeRecord | undefined {
    return this.repo.getAgents(sessionId).find((a) => a.agentId === agentId);
  }

  private saveAgent(sessionId: string, record: AgentNodeRecord): void {
    const existing = this.repo.getAgents(sessionId);
    const idx = existing.findIndex((a) => a.agentId === record.agentId);
    const next =
      idx >= 0 ? existing.map((a, i) => (i === idx ? record : a)) : [...existing, record];
    this.repo.saveAgents(sessionId, next);
  }

  private ensureMainAgentInList(
    session: SessionAgentInfo,
    list: AgentNodeRecord[],
  ): AgentNodeRecord[] {
    const main = list.find((a) => a.agentId === "main");
    if (main) return list;
    return [buildMainAgentRecord(session), ...list];
  }
}
