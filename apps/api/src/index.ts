import { Elysia } from "elysia";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { systemClock } from "@core/time";
import { parseEnv, type Env } from "./env.ts";
import { errorPlugin } from "./plugins.ts";
import { chatRoutes } from "./modules/chat/presentation/chat.routes.ts";
import { markStopped } from "./modules/chat/domain/session.entity.ts";
import type { SessionRepository } from "./modules/chat/domain/repository.port.ts";
import type {
  EventBusPort,
  TerminalRunnerPort,
  TranscriptWatcherPort,
} from "./modules/chat/application/ports.ts";
import { InMemoryEventBus } from "./modules/chat/infrastructure/event-bus.ts";
import { JsonlTranscriptWatcher } from "./modules/chat/infrastructure/jsonl-watcher.ts";
import { FileSessionRepository } from "./modules/chat/infrastructure/session.repository.ts";
import { TmuxRunner } from "./modules/chat/infrastructure/tmux-runner.ts";

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
  defaultCwd?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const env = options.env ?? parseEnv();
  const sessions =
    options.sessions ?? new FileSessionRepository(join(env.harnessHome, "sessions.json"));
  const runner = options.runner ?? new TmuxRunner();
  const watcher = options.watcher ?? new JsonlTranscriptWatcher(env.claudeHome);
  const eventBus = options.eventBus ?? new InMemoryEventBus();
  const defaultCwd = options.defaultCwd ?? process.cwd();

  const app = new Elysia()
    .use(errorPlugin({ host: env.host, token: env.token }))
    .use(
      chatRoutes({
        sessions,
        runner,
        watcher,
        eventBus,
        runtime: { port: env.port, token: env.token, defaultCwd },
      }),
    )
    .get("/api/*", () => new Response(JSON.stringify({ ok: false }), { status: 404 }))
    .get("/*", async ({ path }) => (await serveStatic(path)) ?? serveIndex());

  return { app, env, sessions, runner, watcher, eventBus };
}

export async function reconcilePersistedSessions(
  sessions: SessionRepository,
  runner: TerminalRunnerPort,
  watcher: TranscriptWatcherPort,
  eventBus: EventBusPort,
): Promise<void> {
  const active = await runner.listActiveSessions().catch(() => []);
  const activeNames = new Set(active.map((a) => a.name));

  for (const session of sessions.list({ archived: "all" })) {
    const aliveInTmux = session.tmuxSession ? activeNames.has(session.tmuxSession) : false;

    if (!aliveInTmux && (session.status === "running" || session.status === "waiting_permission")) {
      sessions.save(markStopped(session, systemClock));
    }

    if (!session.archivedAt && session.transcriptPath && (aliveInTmux || existsSync(session.transcriptPath))) {
      await watcher.watch(session.id, session.transcriptPath, (event) => {
        eventBus.publish(session.id, event);
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
  const { app, env, sessions, runner, watcher, eventBus } = createApp();
  await reconcilePersistedSessions(sessions, runner, watcher, eventBus);

  app.listen({ hostname: env.host, port: env.port });
  const actualPort = app.server?.port ?? env.port;
  const runtimePath = writeRuntimeLock(env, actualPort);

  const cleanup = () => {
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
