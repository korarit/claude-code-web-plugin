import { Elysia } from "elysia";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isoNow, systemClock } from "@core/time";
import { parseEnv, type Env } from "./env.ts";
import { errorPlugin } from "./plugins.ts";
import { chatRoutes } from "./modules/chat/presentation/chat.routes.ts";
import { markStopped } from "./modules/chat/domain/session.entity.ts";
import type { SessionRepository } from "./modules/chat/domain/repository.port.ts";
import {
  DiscoverSessionUsecase,
  InteractionCoordinator,
  observeHarnessSessionWithSync,
  watchTranscriptWithSync,
  type AgentTelemetryPort,
  type EventBusPort,
  type FileChangeTrackerPort,
  type HarnessGatewayPort,
  type TerminalAttachPort,
  type TerminalRunnerPort,
  type TranscriptWatcherPort,
  type WorkspacePort,
} from "./modules/chat/application/index.ts";
import { InMemoryEventBus } from "./modules/chat/infrastructure/event-bus.ts";
import { JsonlTranscriptWatcher } from "./modules/chat/infrastructure/jsonl-watcher.ts";
import { FileSessionRepository } from "./modules/chat/infrastructure/session.repository.ts";
import { SessionDiscoveryService } from "./modules/chat/infrastructure/session-discovery.service.ts";
import { TmuxCaptureTerminalAdapter } from "./modules/chat/infrastructure/terminal-attach.service.ts";
import { TmuxRunner } from "./modules/chat/infrastructure/tmux-runner.ts";
import { LocalWorkspaceAdapter } from "./modules/chat/infrastructure/workspace.adapter.ts";
import {
  RecordToolChangeUsecase,
  type ChangeEventPublisherPort,
  type SessionLookupPort,
} from "./modules/changes/application/index.ts";
import { FileChangesRepository } from "./modules/changes/infrastructure/changes.repository.ts";
import { LocalGitWorkspaceAdapter } from "./modules/changes/infrastructure/git-workspace.adapter.ts";
import { LocalWorkspaceFilesAdapter } from "./modules/changes/infrastructure/local-workspace-files.adapter.ts";
import { FileSnapshotStore } from "./modules/changes/infrastructure/snapshot.store.ts";
import { changesRoutes } from "./modules/changes/presentation/changes.routes.ts";
import {
  SyncAgentTelemetryUsecase,
  toAgentNodeContract,
  toTeamTaskContract,
  type AgentTranscriptWatcherPort,
  type SessionAgentLookupPort,
} from "./modules/agents/application/index.ts";
import { InMemoryAgentEventBus } from "./modules/agents/infrastructure/agent-event-bus.ts";
import { FileAgentsRepository } from "./modules/agents/infrastructure/agents.repository.ts";
import { ClaudeTeamTasksWatcher } from "./modules/agents/infrastructure/team-tasks.watcher.ts";
import { agentsRoutes } from "./modules/agents/presentation/agents.routes.ts";
import { LocalGitWorktreeAdapter } from "./modules/workspace/infrastructure/git-worktree.adapter.ts";
import { workspaceRoutes } from "./modules/workspace/presentation/workspace.routes.ts";
import { HarnessRegistry } from "./modules/harness/application/index.ts";
import { AntigravityHarnessAdapter } from "./modules/harness/infrastructure/agy-harness.adapter.ts";
import { ClaudeHarnessAdapter } from "./modules/harness/infrastructure/claude-harness.adapter.ts";
import { OpenCodeHarnessAdapter } from "./modules/harness/infrastructure/opencode-harness.adapter.ts";
import { harnessRoutes } from "./modules/harness/presentation/harness.routes.ts";

const WEB_DIST = join(import.meta.dir, "../../web/dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(path: string): Promise<Response | null> {
  const rel = path === "/" ? "/index.html" : path;
  const normalized = rel.split("?")[0]!;
  if (normalized.includes("..")) return null;
  const file = Bun.file(join(WEB_DIST, normalized));
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: { "content-type": CONTENT_TYPES[extname(normalized)] ?? "application/octet-stream" },
  });
}

async function serveIndex(): Promise<Response> {
  const index = Bun.file(join(WEB_DIST, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("web dist not found. Build it with: bun run build", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export interface CreateAppOptions {
  env?: Env;
  sessions?: SessionRepository;
  runner?: TerminalRunnerPort;
  watcher?: TranscriptWatcherPort;
  eventBus?: EventBusPort;
  coordinator?: InteractionCoordinator;
  terminalAttach?: TerminalAttachPort;
  workspace?: WorkspacePort;
  harnessRegistry?: HarnessRegistry;
  defaultCwd?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? parseEnv();
  const sessions =
    options.sessions ?? new FileSessionRepository(join(env.harnessHome, "sessions.json"));
  const runner = options.runner ?? new TmuxRunner();
  const watcher = options.watcher ?? new JsonlTranscriptWatcher(env.claudeHome);
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const coordinator = options.coordinator ?? new InteractionCoordinator();
  const terminalAttach = options.terminalAttach ?? new TmuxCaptureTerminalAdapter(runner);
  const workspace = options.workspace ?? new LocalWorkspaceAdapter();
  const defaultCwd = options.defaultCwd ?? process.cwd();

  const changesRepo = new FileChangesRepository(join(env.harnessHome, "changes"));
  const snapshotStore = new FileSnapshotStore(join(env.harnessHome, "snapshots"));
  const workspaceFiles = new LocalWorkspaceFilesAdapter();
  const gitWorkspace = new LocalGitWorkspaceAdapter();

  const sessionLookup: SessionLookupPort = {
    getSession: (id) => {
      const s = sessions.get(id);
      if (!s) return null;
      return { id: s.id, cwd: s.cwd, harnessId: s.harnessId, model: s.model };
    },
  };
  const changePublisher: ChangeEventPublisherPort = {
    publishFileChanged: (sessionId, fileChange, timestamp) => {
      eventBus.publish(sessionId, { type: "file_changed", fileChange, timestamp });
    },
  };
  const recordToolChange = new RecordToolChangeUsecase(
    changesRepo,
    snapshotStore,
    workspaceFiles,
    gitWorkspace,
    changePublisher,
    systemClock,
  );
  const fileChangeTracker: FileChangeTrackerPort = {
    onPreToolUse: (input) => recordToolChange.onPreToolUse(input),
    onPostToolUse: (input) => recordToolChange.onPostToolUse(input),
    deleteSession: async (sessionId) => {
      changesRepo.deleteSession(sessionId);
      await snapshotStore.deleteSessionSnapshots(sessionId);
    },
  };

  const agyAdapter =
    (options.harnessRegistry?.find("agy") as AntigravityHarnessAdapter | undefined) ??
    new AntigravityHarnessAdapter({
      agyCliHome: env.agyCliHome,
      agyIdeHome: env.agyIdeHome,
      enableIdeDiscovery: env.enableAgyIdeDiscovery,
    });
  const harnessRegistry =
    options.harnessRegistry ??
    new HarnessRegistry([
      new ClaudeHarnessAdapter({
        claudeHome: env.claudeHome,
        runner,
        watcher,
        defaultCwd,
      }),
      agyAdapter,
      new OpenCodeHarnessAdapter({
        opencodeDataHome: env.opencodeDataHome,
        externalServerUrl: env.opencodeServerUrl,
      }),
    ]);

  const harnessGateway: HarnessGatewayPort = {
    getDefaultModel: (harnessId) => harnessRegistry.get(harnessId).getDefaultModel(),
    isAvailable: (harnessId) => harnessRegistry.get(harnessId).detectAvailability(),
    startOrResumeSession: (harnessId, opts) =>
      harnessRegistry.get(harnessId).startOrResumeSession(opts),
    sendPrompt: (session, prompt, opts) =>
      harnessRegistry.get(session.harnessId).sendPrompt(
        {
          sessionId: session.id,
          externalSessionId: session.externalSessionId,
          tmuxSession: session.tmuxSession,
          transcriptPath: session.transcriptPath,
          cwd: session.cwd,
          model: session.model,
        },
        prompt,
        opts,
      ),
    sendInput: async (session, input, pendingInteraction) => {
      const adapter = harnessRegistry.get(session.harnessId);
      if (!adapter.sendInput) {
        return { handled: false, method: "tmux", resolved: false };
      }
      return adapter.sendInput({
        sessionId: session.id,
        externalSessionId: session.externalSessionId,
        tmuxSession: session.tmuxSession,
        cwd: session.cwd,
        inputType: input.inputType,
        value: input.value,
        interactionId: input.interactionId,
        pendingInteraction,
      });
    },
    abortSession: (session) =>
      harnessRegistry.get(session.harnessId).abortSession({
        sessionId: session.id,
        externalSessionId: session.externalSessionId,
        tmuxSession: session.tmuxSession,
        cwd: session.cwd,
      }),
    stopSession: async (session) => {
      const adapter = harnessRegistry.get(session.harnessId);
      await adapter.stopSession?.({
        sessionId: session.id,
        externalSessionId: session.externalSessionId,
        tmuxSession: session.tmuxSession,
        cwd: session.cwd,
      });
    },
    observeEvents: (session, onEvent, opts) =>
      harnessRegistry.get(session.harnessId).observeEvents(
        {
          sessionId: session.id,
          externalSessionId: session.externalSessionId,
          tmuxSession: session.tmuxSession,
          transcriptPath: session.transcriptPath,
          cwd: session.cwd,
          model: session.model,
        },
        onEvent,
        opts,
      ),
    readRecentEvents: async (session, limit) => {
      const adapter = harnessRegistry.get(session.harnessId);
      if (!adapter.readRecentEvents) return [];
      return adapter.readRecentEvents(
        {
          sessionId: session.id,
          externalSessionId: session.externalSessionId,
          tmuxSession: session.tmuxSession,
          transcriptPath: session.transcriptPath,
          cwd: session.cwd,
          model: session.model,
        },
        limit,
      );
    },
    discoverSessions: () => harnessRegistry.discoverAll(),
    watchExternalSessions: (onUpsert) => harnessRegistry.watchAll(onUpsert),
  };

  const agentsRepo = new FileAgentsRepository(join(env.harnessHome, "agents"));
  const teamTasksWatcher = new ClaudeTeamTasksWatcher(env.claudeHome);
  const agentSessionLookup: SessionAgentLookupPort = {
    getSession: (id) => {
      const s = sessions.get(id);
      if (!s) return null;
      return {
        id: s.id,
        title: s.title,
        model: s.model,
        status: s.status,
        harnessId: s.harnessId,
        externalSessionId: s.externalSessionId,
        transcriptPath: s.transcriptPath,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
      };
    },
    listSessionIds: () => sessions.list({ archived: "all" }).map((s) => s.id),
  };
  const isAgyTranscriptPath = (transcriptPath: string): boolean =>
    transcriptPath.includes("antigravity") ||
    transcriptPath.endsWith(".system_generated/logs/transcript.jsonl") ||
    (Boolean(env.agyCliHome) && transcriptPath.startsWith(env.agyCliHome)) ||
    (Boolean(env.agyIdeHome) && transcriptPath.startsWith(env.agyIdeHome!));

  const agyAgentUnsubscribes = new Map<string, () => void>();
  const agentTranscriptWatcher: AgentTranscriptWatcherPort = {
    watchFromStart: async (watchKey, transcriptPath, onEvent) => {
      if (isAgyTranscriptPath(transcriptPath)) {
        agyAgentUnsubscribes.get(watchKey)?.();
        const stop = await agyAdapter.observeEvents(
          { sessionId: watchKey, transcriptPath },
          (ev) => onEvent(ev),
          { fromBeginning: true },
        );
        agyAgentUnsubscribes.set(watchKey, stop);
        return;
      }
      await watcher.watch(watchKey, transcriptPath, (ev) => onEvent(ev), { fromBeginning: true });
    },
    unwatch: (watchKey) => {
      agyAgentUnsubscribes.get(watchKey)?.();
      agyAgentUnsubscribes.delete(watchKey);
      watcher.unwatch(watchKey);
    },
    readRecentEvents: (transcriptPath, limit) => {
      if (isAgyTranscriptPath(transcriptPath)) {
        return agyAdapter.readRecentEvents({ sessionId: "", transcriptPath }, limit);
      }
      return watcher.readRecentEvents(transcriptPath, limit);
    },
  };
  const agentEventBus = new InMemoryAgentEventBus({
    publishAgentUpdated: (sessionId, agent) => {
      const contract = toAgentNodeContract(agent);
      eventBus.publish(sessionId, {
        type: "agent_updated",
        agentId: agent.agentId,
        agent: contract,
        timestamp: agent.updatedAt,
      });
      eventBus.publishListEvent({
        type: "agent_updated",
        sessionId,
        agent: contract,
      });
    },
    publishTasksUpdated: (sessionId, tasks) => {
      eventBus.publish(sessionId, {
        type: "tasks_updated",
        tasks: tasks.map(toTeamTaskContract),
        timestamp: isoNow(systemClock),
      });
    },
  });
  const syncAgents = new SyncAgentTelemetryUsecase(
    agentsRepo,
    agentSessionLookup,
    agentTranscriptWatcher,
    teamTasksWatcher,
    agentEventBus,
    systemClock,
    fileChangeTracker,
  );
  const agentTelemetry: AgentTelemetryPort = {
    onHookEvent: (sessionId, hook, externalSessionId) =>
      syncAgents.onHookEvent({
        sessionId,
        externalSessionId,
        cwd: hook.cwd,
        hookEventName: hook.hookEventName,
        toolName: hook.toolName,
        toolUseId: hook.toolUseId,
        toolInput: hook.toolInput,
        agentId: hook.agentId,
        agentType: hook.agentType,
        agentTranscriptPath: hook.agentTranscriptPath,
        teammateName: hook.teammateName,
        taskId: hook.taskId,
        taskSubject: hook.taskSubject,
        taskStatus: hook.taskStatus,
      }),
    onTranscriptEvent: (sessionId, event) =>
      syncAgents.onMainTranscriptEvent(sessionId, {
        ...event,
        agentRecord: event.agent
          ? {
              ...event.agent,
              recentLogs: event.agent.recentLogs ?? [],
              startedAt: event.agent.startedAt ?? event.agent.updatedAt,
            }
          : undefined,
      }),
    deleteSession: (sessionId) => syncAgents.deleteSession(sessionId),
  };

  const gitWorktree = new LocalGitWorktreeAdapter();

  const discoverUsecase = new DiscoverSessionUsecase(
    sessions,
    watcher,
    eventBus,
    systemClock,
    coordinator,
    fileChangeTracker,
    agentTelemetry,
    harnessGateway,
  );
  const discovery = new SessionDiscoveryService({
    claudeHome: env.claudeHome,
    discoverUsecase,
    runner,
    discoverExternalSessions: () => harnessRegistry.discoverAll(),
    watchExternalSessions: (onUpsert) => harnessRegistry.watchAll(onUpsert),
  });

  const app = new Elysia()
    .use(errorPlugin({ host: env.host, token: env.token }))
    .use(harnessRoutes({ registry: harnessRegistry }))
    .use(
      chatRoutes({
        sessions,
        runner,
        watcher,
        eventBus,
        coordinator,
        terminalAttach,
        workspace,
        fileChangeTracker,
        agentTelemetry,
        harnessGateway,
        runtime: {
          port: env.port,
          token: env.token,
          defaultCwd,
          anthropicApiKey: env.anthropicApiKey,
          concurrencySoftLimit: env.concurrencySoftLimit,
          permissionHookTimeoutMs: env.permissionHookTimeoutMs,
        },
      }),
    )
    .use(
      changesRoutes({
        sessions: sessionLookup,
        repo: changesRepo,
        snapshots: snapshotStore,
        files: workspaceFiles,
        git: gitWorkspace,
        defaultCwd,
      }),
    )
    .use(
      agentsRoutes({
        sessions: agentSessionLookup,
        repo: agentsRepo,
        watcher: agentTranscriptWatcher,
        publisher: agentEventBus,
        syncUsecase: syncAgents,
      }),
    )
    .use(
      workspaceRoutes({
        git: gitWorktree,
        defaultCwd,
      }),
    )
    .get("/api/*", () => new Response(JSON.stringify({ ok: false }), { status: 404 }))
    .get("/*", async ({ path }) => (await serveStatic(path)) ?? serveIndex());

  return {
    app,
    env,
    sessions,
    runner,
    watcher,
    eventBus,
    coordinator,
    discovery,
    fileChangeTracker,
    changesRepo,
    agentsRepo,
    agentTelemetry,
    syncAgents,
    harnessRegistry,
    harnessGateway,
  };
}

export async function reconcilePersistedSessions(
  sessions: SessionRepository,
  runner: TerminalRunnerPort,
  watcher: TranscriptWatcherPort,
  eventBus: EventBusPort,
  coordinator?: InteractionCoordinator,
  fileChangeTracker?: FileChangeTrackerPort,
  agentTelemetry?: AgentTelemetryPort,
  harnessGateway?: HarnessGatewayPort,
): Promise<void> {
  const active = await runner.listActiveSessions().catch(() => []);
  const activeNames = new Set(active.map((a) => a.name));

  for (const session of sessions.list({ archived: "all" })) {
    let current = session;
    const aliveInTmux = current.tmuxSession ? activeNames.has(current.tmuxSession) : false;

    if (!aliveInTmux && (current.status === "running" || current.status === "waiting_permission")) {
      current = markStopped(current, systemClock);
      sessions.save(current);
    }

    if (
      !current.archivedAt &&
      ((current.transcriptPath && (aliveInTmux || existsSync(current.transcriptPath))) ||
        current.harnessId === "opencode")
    ) {
      if (harnessGateway) {
        await observeHarnessSessionWithSync(current, {
          sessions,
          harnessGateway,
          watcher,
          eventBus,
          coordinator,
          fileChangeTracker,
          agentTelemetry,
        });
      } else if (current.transcriptPath) {
        await watchTranscriptWithSync(current.id, current.transcriptPath, {
          sessions,
          watcher,
          eventBus,
          coordinator,
          fileChangeTracker,
          agentTelemetry,
        });
      }
    }
  }
}

function writeRuntimeLock(env: Env, actualPort: number): string {
  mkdirSync(env.harnessHome, { recursive: true, mode: 0o700 });
  const runtimePath = join(env.harnessHome, "runtime.json");
  const payload = {
    port: actualPort,
    host: env.host,
    pid: process.pid,
    token: env.token,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(runtimePath, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return runtimePath;
}

if (import.meta.main) {
  const {
    app,
    env,
    sessions,
    runner,
    watcher,
    eventBus,
    coordinator,
    discovery,
    fileChangeTracker,
    agentTelemetry,
    harnessRegistry,
    harnessGateway,
  } = createApp();
  await reconcilePersistedSessions(
    sessions,
    runner,
    watcher,
    eventBus,
    coordinator,
    fileChangeTracker,
    agentTelemetry,
    harnessGateway,
  );
  discovery.start();

  app.listen({ hostname: env.host, port: env.port });
  const actualPort = app.server?.port ?? env.port;
  const runtimePath = writeRuntimeLock(env, actualPort);

  const cleanup = () => {
    discovery.stop();
    void harnessRegistry.dispose();
    try {
      rmSync(runtimePath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  console.log(
    `harness-web listening on http://${env.host}:${actualPort} (api + web, same port)`,
  );
}
