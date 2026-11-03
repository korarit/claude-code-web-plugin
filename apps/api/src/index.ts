import { Elysia } from "elysia";
import { join, extname } from "node:path";
import { parseEnv } from "./env.ts";
import { errorPlugin } from "./plugins.ts";
import { chatRoutes } from "./modules/chat/presentation/chat.routes.ts";
import { BunClaudeRunner } from "./modules/chat/infrastructure/claude-runner.ts";
import { InMemorySessionRepository } from "./modules/chat/infrastructure/session.repository.ts";

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
  // Block path traversal.
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
  return new Response("web dist not found. Build it with: bun --filter web build", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

const sessions = new InMemorySessionRepository();
const runner = new BunClaudeRunner();

const app = new Elysia()
  .use(errorPlugin)
  .use(chatRoutes(runner, sessions))
  .get("/api/*", () => new Response(JSON.stringify({ ok: false }), { status: 404 }))
  .get("/*", async ({ path }) => (await serveStatic(path)) ?? serveIndex());

const { port } = parseEnv();
app.listen(port);
console.log(`claude-web listening on http://localhost:${port} (api + web, same port)`);
