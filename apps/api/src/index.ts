import { Elysia } from "elysia";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { systemClock } from "@core/time";
import { parseEnv, type Env } from "./env.ts";
import { errorPlugin } from "./plugins.ts";
import { chatRoutes } from "./modules/chat/presentation/chat.routes.ts";
import { markStopped } from "./modules/chat/domain/session.entity.ts";
import type { SessionRepository } from "./modules/chat/domain/repository.port.ts";
import {
  DiscoverSessionUsecase,
  InteractionCoordinator,
  watchTranscriptWithSync,
  type EventBusPort,
  type FileChangeTrackerPort,
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

  const discoverUsecase = new DiscoverSessionUsecase(
    sessions,
    watcher,
    eventBus,
    systemClock,
    coordinator,
    fileChangeTracker,
  );
  const discovery = new SessionDiscoveryService({
    claudeHome: env.claudeHome,
    discoverUsecase,
    runner,
  });

  const app = new Elysia()
    .use(errorPlugin({ host: env.host, token: env.token }))
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
  };
}

export async function reconcilePersistedSessions(
  sessions: SessionRepository,
  runner: TerminalRunnerPort,
  watcher: TranscriptWatcherPort,
  eventBus: EventBusPort,
  coordinator?: InteractionCoordinator,
  fileChangeTracker?: FileChangeTrackerPort,
): Promise<void> {
  const active = await runner.listActiveSessions().catch(() => []);
  const activeNames = new Set(active.map((a) => a.name));

  for (const session of sessions.list({ archived: "all" })) {
    const aliveInTmux = session.tmuxSession ? activeNames.has(session.tmuxSession) : false;

    if (!aliveInTmux && (session.status === "running" || session.status === "waiting_permission")) {
      sessions.save(markStopped(session, systemClock));
    }

    if (
      !session.archivedAt &&
      session.transcriptPath &&
      (aliveInTmux || existsSync(session.transcriptPath))
    ) {
      await watchTranscriptWithSync(session.id, session.transcriptPath, {
        sessions,
        watcher,
        eventBus,
        coordinator,
        fileChangeTracker,
      });
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
  } = createApp();
  await reconcilePersistedSessions(
    sessions,
    runner,
    watcher,
    eventBus,
    coordinator,
    fileChangeTracker,
  );
  discovery.start();

  app.listen({ hostname: env.host, port: env.port });
  const actualPort = app.server?.port ?? env.port;
  const runtimePath = writeRuntimeLock(env, actualPort);

  const cleanup = () => {
    discovery.stop();
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
