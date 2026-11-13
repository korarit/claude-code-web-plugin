import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.ts";
import {
  buildQuestionKeystrokes,
  DiscoverSessionUsecase,
  HandleHookUsecase,
  InteractionCoordinator,
  ResumeSessionUsecase,
  SendInputUsecase,
  SendMessageUsecase,
  type TerminalRunnerPort,
  type TranscriptWatcherPort,
} from "../src/modules/chat/application/index.ts";
import {
  ApiKeyNotConfiguredError,
  MirrorSessionError,
} from "../src/modules/chat/domain/errors.ts";
import { InMemoryEventBus } from "../src/modules/chat/infrastructure/event-bus.ts";
import { encodeClaudeProjectDir, JsonlTranscriptWatcher } from "../src/modules/chat/infrastructure/jsonl-watcher.ts";
import { FileSessionRepository } from "../src/modules/chat/infrastructure/session.repository.ts";
import { SessionDiscoveryService } from "../src/modules/chat/infrastructure/session-discovery.service.ts";

function makeRecorderRunner(activePanes: Array<{ name: string; cwd?: string; paneCommand?: string }> = []) {
  const calls: string[] = [];
  const runner: TerminalRunnerPort = {
    isAvailable: async () => true,
    ensureSession: async ({ sessionId, resumeSessionId, authMode, agentProfile }) => {
      calls.push(
        `ensure:${sessionId}:resume=${resumeSessionId ?? ""}:auth=${authMode ?? ""}:agent=${agentProfile ?? ""}`,
      );
      return { tmuxSession: `cw-${sessionId.slice(0, 8)}`, isNew: true };
    },
    sendPrompt: async (tmux, prompt) => {
      calls.push(`prompt:${tmux}:${prompt}`);
    },
    sendRawKeys: async (tmux, key) => {
      calls.push(`key:${tmux}:${key}`);
    },
    sendKeysSequence: async (tmux, keys) => {
      calls.push(`seq:${tmux}:${keys.join(",")}`);
    },
    capturePane: async () => "Claude Code\n❯ ",
    abortSession: async () => {},
    stopSession: async () => {},
    listActiveSessions: async () => activePanes,
  };
  return { runner, calls };
}

function makeStubWatcher(): TranscriptWatcherPort {
  return {
    resolveTranscriptPath: (cwd, sessionId) => join(cwd, `${sessionId}.jsonl`),
    watch: async () => {},
    unwatch: () => {},
    readRecentEvents: async () => [],
  };
}

describe("Phase 2: Interactive Controls, Discovery & Auth Modes", () => {
  test("PermissionRequest hook holds until SendInputUsecase resolves it, and times out cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-p2-perm-"));
    try {
      const repo = new FileSessionRepository(join(dir, "sessions.json"));
      const { runner } = makeRecorderRunner();
      const watcher = makeStubWatcher();
      const bus = new InMemoryEventBus();
      const coordinator = new InteractionCoordinator();

      const sendUc = new SendMessageUsecase(
        repo,
        runner,
        watcher,
        bus,
        { port: 3000, token: "tok", defaultCwd: dir },
        undefined,
        coordinator,
      );
      const sent = await sendUc.execute({ prompt: "Run tests" });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      const sessionId = sent.value.session.id;

      const hookUc = new HandleHookUsecase(repo, watcher, bus, runner, undefined, coordinator, 500);
      const inputUc = new SendInputUsecase(repo, runner, bus, coordinator);

      // Start blocking PermissionRequest hook
      const hookPromise = hookUc.execute({
        sessionId,
        hookEventName: "PermissionRequest",
        toolName: "Bash",
        toolInput: { command: "bun test" },
        waitForDecision: true,
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(repo.get(sessionId)?.status).toBe("waiting_permission");
      expect(repo.get(sessionId)?.pendingInteraction?.kind).toBe("permission");

      const resolveRes = await inputUc.execute({
        sessionId,
        inputType: "decision",
        value: "allow_once",
      });
      expect(resolveRes.ok).toBe(true);
      if (resolveRes.ok) expect(resolveRes.value.method).toBe("hook");

      const hookOut = await hookPromise;
      expect(hookOut.ok).toBe(true);
      if (hookOut.ok) {
        expect(hookOut.value.decision).toBe("allow_once");
      }
      expect(repo.get(sessionId)?.status).toBe("running");
      expect(repo.get(sessionId)?.pendingInteraction).toBeNull();

      // Timeout fallback when user does not respond
      const shortHookUc = new HandleHookUsecase(repo, watcher, bus, runner, undefined, coordinator, 40);
      const timedOut = await shortHookUc.execute({
        sessionId,
        hookEventName: "PermissionRequest",
        toolName: "Write",
        waitForDecision: true,
      });
      expect(timedOut.ok).toBe(true);
      if (timedOut.ok) expect(timedOut.value.decision).toBe("timeout");

      // PostToolUse after timeout still emits interaction_resolved with the previous interactionId
      const pendingIdBeforeStop = repo.get(sessionId)?.pendingInteraction?.id;
      expect(pendingIdBeforeStop).toBeDefined();
      const postEvents: string[] = [];
      const unsub = bus.subscribe(sessionId, (ev) => {
        if (ev.type === "interaction_resolved" && ev.interactionId) {
          postEvents.push(ev.interactionId);
        }
      });
      await shortHookUc.execute({ sessionId, hookEventName: "PostToolUse", toolName: "Write" });
      unsub();
      expect(postEvents).toContain(pendingIdBeforeStop!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AskUserQuestion builds accurate single/multi-select keystrokes and injects into tmux", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-p2-q-"));
    try {
      const steps = buildQuestionKeystrokes(
        [
          {
            id: "db",
            prompt: "DB?",
            multiSelect: false,
            options: [
              { id: "SQLite", label: "SQLite" },
              { id: "Postgres", label: "Postgres" },
            ],
          },
          {
            id: "features",
            prompt: "Features?",
            multiSelect: true,
            options: [
              { id: "Auth", label: "Auth" },
              { id: "Logs", label: "Logs" },
              { id: "Metrics", label: "Metrics" },
            ],
          },
        ],
        { db: "Postgres", features: ["Auth", "Metrics"] },
      );

      expect(steps).toEqual([
        { keys: ["Down", "Enter"] },
        { keys: ["Space"] },
        { keys: ["Down"] },
        { keys: ["Down"] },
        { keys: ["Space"] },
        { keys: ["Enter"] },
        { keys: ["Enter"] },
      ]);

      // Multi-select with custom answer text navigates to custom row and sends text
      const multiCustomSteps = buildQuestionKeystrokes(
        [
          {
            id: "tags",
            prompt: "Tags?",
            multiSelect: true,
            allowCustomText: true,
            options: [
              { id: "UI", label: "UI" },
              { id: "API", label: "API" },
            ],
          },
        ],
        { tags: ["UI", "CustomTag"] },
      );
      expect(multiCustomSteps).toEqual([
        { keys: ["Space"] },
        { keys: ["Down"] },
        { keys: ["Down"] },
        { keys: ["Enter"] },
        { text: "CustomTag" },
      ]);

      const repo = new FileSessionRepository(join(dir, "sessions.json"));
      const { runner, calls } = makeRecorderRunner();
      const watcher = makeStubWatcher();
      const bus = new InMemoryEventBus();
      const coordinator = new InteractionCoordinator();

      const sendUc = new SendMessageUsecase(repo, runner, watcher, bus, {
        port: 3000,
        token: "tok",
        defaultCwd: dir,
      });
      const sent = await sendUc.execute({ prompt: "Setup project" });
      if (!sent.ok) throw new Error("send failed");
      const sessionId = sent.value.session.id;

      coordinator.setPending(sessionId, {
        id: "q-1",
        sessionId,
        kind: "question",
        questions: [
          {
            id: "db",
            prompt: "DB?",
            multiSelect: false,
            options: [
              { id: "SQLite", label: "SQLite" },
              { id: "Postgres", label: "Postgres" },
            ],
          },
        ],
        createdAt: new Date().toISOString(),
      });

      const inputUc = new SendInputUsecase(repo, runner, bus, coordinator);
      const res = await inputUc.execute({
        sessionId,
        inputType: "selection",
        value: { db: "Postgres" },
      });
      expect(res.ok).toBe(true);
      expect(calls.some((c) => c.includes("Down,Enter"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SessionDiscoveryService auto-discovers CLI & external tmux sessions without duplicates and ResumeSessionUsecase takes over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-p2-disc-"));
    const claudeHome = join(dir, ".claude");
    const repoCli = join(dir, "proj-cli");
    const repoTmux = join(dir, "proj-tmux");
    mkdirSync(repoCli, { recursive: true });
    mkdirSync(repoTmux, { recursive: true });

    try {
      const cliProjDir = join(claudeHome, "projects", encodeClaudeProjectDir(repoCli));
      const tmuxProjDir = join(claudeHome, "projects", encodeClaudeProjectDir(repoTmux));
      mkdirSync(cliProjDir, { recursive: true });
      mkdirSync(tmuxProjDir, { recursive: true });

      writeFileSync(
        join(cliProjDir, "ext-cli-1.jsonl"),
        JSON.stringify({
          type: "user",
          cwd: repoCli,
          sessionId: "ext-cli-1",
          message: { role: "user", content: "Inspect auth module" },
        }) + "\n",
      );
      writeFileSync(
        join(tmuxProjDir, "ext-tmux-1.jsonl"),
        JSON.stringify({
          type: "user",
          cwd: repoTmux,
          sessionId: "ext-tmux-1",
          message: { role: "user", content: "Refactor router" },
        }) + "\n",
      );

      const repo = new FileSessionRepository(join(dir, "sessions.json"));
      const { runner, calls } = makeRecorderRunner([
        { name: "work-tmux", cwd: repoTmux, paneCommand: "claude" },
      ]);
      const watcher = new JsonlTranscriptWatcher(claudeHome);
      const bus = new InMemoryEventBus();
      const discoverUc = new DiscoverSessionUsecase(repo, watcher, bus);
      const discovery = new SessionDiscoveryService({
        claudeHome,
        discoverUsecase: discoverUc,
        runner,
      });

      await discovery.scanOnce();
      await discovery.scanOnce(); // Idempotent check

      const all = repo.list({ archived: "all" });
      expect(all).toHaveLength(2);

      const cliSession = all.find((s) => s.externalSessionId === "ext-cli-1")!;
      const tmuxSession = all.find((s) => s.externalSessionId === "ext-tmux-1")!;

      expect(cliSession.origin).toBe("cli");
      expect(cliSession.controlMode).toBe("mirror");
      expect(cliSession.lastMessagePreview).toBe("Inspect auth module");

      expect(tmuxSession.origin).toBe("tmux");
      expect(tmuxSession.controlMode).toBe("interactive");
      expect(tmuxSession.tmuxSession).toBe("work-tmux");

      // Direct send to mirror session is rejected with MirrorSessionError
      const sendUc = new SendMessageUsecase(repo, runner, watcher, bus, {
        port: 3000,
        token: "tok",
        defaultCwd: dir,
      });
      const mirrorSend = await sendUc.execute({
        sessionId: cliSession.id,
        prompt: "Continue",
      });
      expect(mirrorSend.ok).toBe(false);
      if (!mirrorSend.ok) expect(mirrorSend.error).toBeInstanceOf(MirrorSessionError);

      // Continue in Web resumes mirror session into interactive tmux
      const resumeUc = new ResumeSessionUsecase(repo, runner, watcher, bus, {
        port: 3000,
        token: "tok",
        defaultCwd: dir,
      });
      const resumed = await resumeUc.execute({ sessionId: cliSession.id, model: "opus" });
      expect(resumed.ok).toBe(true);
      if (resumed.ok) {
        expect(resumed.value.session.controlMode).toBe("interactive");
        expect(resumed.value.session.model).toBe("opus");
      }
      expect(calls.some((c) => c.includes("resume=ext-cli-1"))).toBe(true);

      watcher.unwatch(cliSession.id);
      watcher.unwatch(tmuxSession.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AuthMode validation, mid-session /model switch, and concurrency soft-warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-p2-auth-"));
    try {
      const repo = new FileSessionRepository(join(dir, "sessions.json"));
      const { runner } = makeRecorderRunner();
      const watcher = makeStubWatcher();
      const bus = new InMemoryEventBus();

      const noKeySend = new SendMessageUsecase(repo, runner, watcher, bus, {
        port: 3000,
        token: "tok",
        defaultCwd: dir,
        concurrencySoftLimit: 1,
      });

      const missingKeyRes = await noKeySend.execute({
        prompt: "Hello",
        authMode: "api_key",
      });
      expect(missingKeyRes.ok).toBe(false);
      if (!missingKeyRes.ok) {
        expect(missingKeyRes.error).toBeInstanceOf(ApiKeyNotConfiguredError);
      }

      // First machine_default session (within limit 1) -> no warning
      const s1 = await noKeySend.execute({ prompt: "First", model: "sonnet" });
      expect(s1.ok).toBe(true);
      if (!s1.ok) return;
      expect(s1.value.concurrencyWarning).toBeUndefined();

      // Second concurrent machine_default session -> emits concurrencyWarning
      const s2 = await noKeySend.execute({ prompt: "Second", model: "sonnet" });
      expect(s2.ok).toBe(true);
      if (s2.ok) {
        expect(s2.value.concurrencyWarning).toEqual({ activeCount: 2, limit: 1 });
      }

      // Stop s1 and switch model mid-session via /model opus
      const hookUc = new HandleHookUsecase(repo, watcher, bus, runner);
      await hookUc.execute({ sessionId: s1.value.session.id, hookEventName: "Stop" });
      const switched = await noKeySend.execute({
        sessionId: s1.value.session.id,
        prompt: "/model opus",
      });
      expect(switched.ok).toBe(true);
      if (switched.ok) {
        expect(switched.value.session.model).toBe("opus");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HTTP integration: PermissionRequest long-poll via hook-forwarder.sh, workspace files, and image upload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-p2-http-"));
    const claudeHome = join(dir, ".claude");
    const harnessHome = join(dir, ".harness-web");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/auth.ts"), "export const ok = true;\n");

    try {
      const { runner } = makeRecorderRunner();
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p2-token",
          permissionHookTimeoutMs: 5_000,
        },
        runner,
        defaultCwd: dir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        const sendRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Check repo" }),
        });
        const sendData = (await sendRes.json()) as { data: { session: { id: string } } };
        const sessionId = sendData.data.session.id;

        // Run hook-forwarder.sh with PermissionRequest -> should block until /api/chat/input
        const runtimeFile = join(harnessHome, "runtime.json");
        mkdirSync(harnessHome, { recursive: true });
        writeFileSync(
          runtimeFile,
          JSON.stringify({ port, pid: process.pid, token: "p2-token" }),
          "utf8",
        );

        const hookScript = join(import.meta.dir, "../../../plugins/web/scripts/hook-forwarder.sh");
        const proc = Bun.spawn(["bash", hookScript], {
          stdin: new TextEncoder().encode(
            JSON.stringify({
              hook_event_name: "PermissionRequest",
              tool_name: "Bash",
              tool_input: { command: "ls -la" },
            }),
          ),
          stdout: "pipe",
          env: {
            ...process.env,
            HARNESS_WEB_HOME: harnessHome,
            CLAUDE_WEB_SESSION_ID: sessionId,
          },
        });

        // Wait briefly for hook to reach API and set waiting_permission
        for (let i = 0; i < 20; i++) {
          const sRes = await fetch(`${base}/api/chat/sessions`);
          const sJson = (await sRes.json()) as {
            data: { sessions: Array<{ id: string; status: string }> };
          };
          if (sJson.data.sessions[0]?.status === "waiting_permission") break;
          await new Promise((r) => setTimeout(r, 25));
        }

        const inputRes = await fetch(`${base}/api/chat/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            inputType: "decision",
            value: "allow_once",
          }),
        });
        expect(inputRes.status).toBe(200);

        const [hookStdout, hookExit] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(hookExit).toBe(0);
        if (hookStdout.trim()) {
          expect(hookStdout).toContain('"behavior":"allow"');
        }

        // Workspace file autocomplete endpoint
        const filesRes = await fetch(`${base}/api/workspace/files?q=auth`);
        expect(filesRes.status).toBe(200);
        const filesJson = (await filesRes.json()) as {
          data: { files: Array<{ path: string }> };
        };
        expect(filesJson.data.files.some((f) => f.path === "src/auth.ts")).toBe(true);

        // Image upload endpoint
        const form = new FormData();
        form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
        const uploadRes = await fetch(`${base}/api/chat/upload`, {
          method: "POST",
          body: form,
        });
        expect(uploadRes.status).toBe(200);
        const uploadJson = (await uploadRes.json()) as {
          data: { path: string; size: number };
        };
        expect(uploadJson.data.size).toBe(4);
        expect(uploadJson.data.path).toContain("shot.png");
      } finally {
        await server.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
