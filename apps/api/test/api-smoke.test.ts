import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, reconcilePersistedSessions } from "../src/index.ts";
import type { TerminalRunnerPort } from "../src/modules/chat/application/ports.ts";
import { InMemoryEventBus } from "../src/modules/chat/infrastructure/event-bus.ts";
import { JsonlTranscriptWatcher } from "../src/modules/chat/infrastructure/jsonl-watcher.ts";
import { FileSessionRepository } from "../src/modules/chat/infrastructure/session.repository.ts";

function makeStubRunner(activeNames: string[] = []): TerminalRunnerPort {
  return {
    isAvailable: async () => true,
    ensureSession: async ({ sessionId }) => ({
      tmuxSession: `cw-${sessionId.slice(0, 8)}`,
      isNew: true,
    }),
    sendPrompt: async () => {},
    sendRawKeys: async () => {},
    abortSession: async () => {},
    stopSession: async () => {},
    listActiveSessions: async () => activeNames.map((name) => ({ name })),
  };
}

describe("API HTTP & SSE integration smoke", () => {
  test("handles send, hooks, SSE streams, security checks, and restart reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-smoke-"));
    const claudeHome = join(dir, ".claude");
    const harnessHome = join(dir, ".harness-web");

    try {
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "test-secret-token",
        },
        runner: makeStubRunner(),
        defaultCwd: dir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port;
      expect(port).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${port}`;

      try {
        // 1) Health check
        const health = await fetch(`${base}/api/health`);
        expect(health.status).toBe(200);

        // 2) Security: reject cross-origin and invalid token
        const evilRes = await fetch(`${base}/api/chat/sessions`, {
          headers: { origin: "https://evil.example" },
        });
        expect(evilRes.status).toBe(403);

        const badTokenRes = await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-harness-token": "wrong" },
          body: JSON.stringify({ hook_event_name: "Stop" }),
        });
        expect(badTokenRes.status).toBe(401);

        // 3) Connect global sidebar SSE
        const listController = new AbortController();
        const listSse = await fetch(`${base}/api/chat/sessions/events`, {
          signal: listController.signal,
        });
        expect(listSse.status).toBe(200);
        const listReader = listSse.body!.getReader();
        const decoder = new TextDecoder();
        const firstChunk = await listReader.read();
        expect(decoder.decode(firstChunk.value)).toContain("event: snapshot");

        // 4) Send prompt -> creates session
        const sendRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Smoke test prompt", model: "sonnet" }),
        });
        expect(sendRes.status).toBe(202);
        const sendJson = (await sendRes.json()) as {
          ok: boolean;
          data: { session: { id: string; transcriptPath: string } };
        };
        const sessionId = sendJson.data.session.id;

        // Global sidebar SSE receives upsert
        const upsertChunk = await listReader.read();
        expect(decoder.decode(upsertChunk.value)).toContain("event: upsert");
        listController.abort();

        // 5) Connect session SSE + send Stop hook + write JSONL assistant message
        const sessionController = new AbortController();
        const sessionSse = await fetch(`${base}/api/chat/sessions/${sessionId}/events`, {
          signal: sessionController.signal,
        });
        expect(sessionSse.status).toBe(200);
        const sessionReader = sessionSse.body!.getReader();

        const initialChunk = await sessionReader.read();
        const initialText = decoder.decode(initialChunk.value);
        expect(initialText).toContain('"status":"running"');
        expect(initialText).toContain("Smoke test prompt");

        // Send Stop hook with valid token
        const hookRes = await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "test-secret-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({ hook_event_name: "Stop" }),
        });
        expect(hookRes.status).toBe(200);

        const hookChunk = await sessionReader.read();
        expect(decoder.decode(hookChunk.value)).toContain('"status":"idle"');
        sessionController.abort();

        // 6) Verify hook-forwarder.sh against live server and stopped server
        const runtimeFile = join(harnessHome, "runtime.json");
        writeFileSync(
          runtimeFile,
          JSON.stringify({ port, pid: process.pid, token: "test-secret-token" }),
          "utf8",
        );

        const hookScript = join(import.meta.dir, "../../../plugins/web/scripts/hook-forwarder.sh");
        const liveProc = Bun.spawn(["bash", hookScript], {
          stdin: new TextEncoder().encode(
            JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read" }),
          ),
          env: {
            ...process.env,
            HARNESS_WEB_HOME: harnessHome,
            CLAUDE_WEB_SESSION_ID: sessionId,
          },
        });
        expect(await liveProc.exited).toBe(0);

        // Rename session and verify reconciliation after restart
        const renameRes = await fetch(`${base}/api/chat/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Persisted Smoke" }),
        });
        expect(renameRes.status).toBe(200);

        // Append a dummy jsonl file to verify replay on restart
        const transcriptPath = sendJson.data.session.transcriptPath;
        const { mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        mkdirSync(dirname(transcriptPath), { recursive: true });
        appendFileSync(
          transcriptPath,
          JSON.stringify({
            type: "assistant",
            uuid: "a-smoke",
            message: { role: "assistant", content: [{ type: "text", text: "Reply from JSONL" }] },
          }) + "\n",
        );
      } finally {
        await server.stop(true);
      }

      // 7) Restart reconciliation check
      const repo2 = new FileSessionRepository(join(harnessHome, "sessions.json"));
      const watcher2 = new JsonlTranscriptWatcher(claudeHome);
      const bus2 = new InMemoryEventBus();
      await reconcilePersistedSessions(repo2, makeStubRunner([]), watcher2, bus2);
      const listAfter = repo2.list({ archived: "all" });
      expect(listAfter).toHaveLength(1);
      expect(listAfter[0]?.title).toBe("Persisted Smoke");
      expect(listAfter[0]?.status).toBe("stopped");
      watcher2.unwatch(listAfter[0]!.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hook-forwarder.sh exits 0 within < 200ms when server is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-hook-off-"));
    try {
      const hookScript = join(import.meta.dir, "../../../plugins/web/scripts/hook-forwarder.sh");
      const t0 = performance.now();
      const proc = Bun.spawn(["bash", hookScript], {
        stdin: new TextEncoder().encode('{"hook_event_name":"Stop"}'),
        env: { ...process.env, HARNESS_WEB_HOME: dir, CLAUDE_WEB_PORT: "", CLAUDE_WEB_TOKEN: "" },
      });
      const code = await proc.exited;
      const elapsed = performance.now() - t0;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
