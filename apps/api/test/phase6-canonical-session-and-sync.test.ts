import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalSessionResponse,
  ChatStreamEvent,
  SessionInfo,
  SwitchHarnessResponse,
} from "@contracts/index";
import type { Env } from "../src/env.ts";
import { createApp, reconcilePersistedSessions } from "../src/index.ts";
import type { TerminalRunnerPort } from "../src/modules/chat/application/ports.ts";
import { JsonlTranscriptWatcher } from "../src/modules/chat/infrastructure/jsonl-watcher.ts";
import { HarnessRegistry } from "../src/modules/harness/application/harness-registry.ts";
import type {
  HarnessAdapter,
  HarnessSessionContext,
  NormalizedHarnessEvent,
  StartedHarnessSession,
  StartHarnessSessionOptions,
} from "../src/modules/harness/domain/harness.port.ts";
import { ClaudeHarnessAdapter } from "../src/modules/harness/infrastructure/claude-harness.adapter.ts";
import { OpenCodeNativeImporterAdapter } from "../src/modules/sync/infrastructure/opencode-native-importer.adapter.ts";

function makeEnv(root: string, overrides: Partial<Env> = {}): Env {
  return {
    port: 0,
    host: "127.0.0.1",
    harnessHome: join(root, "harness-web"),
    claudeHome: join(root, "claude"),
    agyCliHome: join(root, "agy-cli"),
    agyIdeHome: join(root, "agy-ide"),
    enableAgyIdeDiscovery: true,
    opencodeDataHome: join(root, "opencode-data"),
    token: "phase6-test-token",
    anthropicApiKey: undefined,
    concurrencySoftLimit: 5,
    permissionHookTimeoutMs: 5000,
    syncByteThreshold: 20 * 1024,
    syncTurnThreshold: 40,
    opencodeNativeImport: false,
    ...overrides,
  };
}

class StubHarnessAdapter implements HarnessAdapter {
  readonly capabilities = {
    hooks: true,
    jsonlTranscript: true,
    serverApi: false,
    resume: true,
    subagents: false,
    externalDiscovery: false,
  };

  readonly sentPrompts: Array<{ session: HarnessSessionContext; prompt: string }> = [];
  readonly startCalls: StartHarnessSessionOptions[] = [];
  private listeners = new Map<string, (event: NormalizedHarnessEvent) => void>();

  constructor(
    readonly id: "claude" | "agy" | "opencode",
    readonly name: string,
    private readonly defaultModel: string,
    private readonly models: string[],
    private readonly onStart?: (opts: StartHarnessSessionOptions) => StartedHarnessSession,
  ) {}

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async detectAvailability(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<string[]> {
    return this.models;
  }

  async startOrResumeSession(options: StartHarnessSessionOptions): Promise<StartedHarnessSession> {
    this.startCalls.push(options);
    if (this.onStart) return this.onStart(options);
    return {
      harnessId: this.id,
      externalSessionId: options.resumeSessionId ?? `${this.id}-ext-${options.sessionId.slice(0, 6)}`,
      tmuxSession:
        this.id === "opencode"
          ? undefined
          : (options.tmuxSessionName ?? `cw-${options.sessionId.slice(0, 8)}-${this.id}`),
      isNew: !options.resumeSessionId,
    };
  }

  async sendPrompt(session: HarnessSessionContext, prompt: string): Promise<void> {
    this.sentPrompts.push({ session, prompt });
  }

  async abortSession(): Promise<void> {}

  async observeEvents(
    session: HarnessSessionContext,
    onEvent: (event: NormalizedHarnessEvent) => void,
  ): Promise<() => void> {
    this.listeners.set(session.sessionId, onEvent);
    return () => {
      if (this.listeners.get(session.sessionId) === onEvent) {
        this.listeners.delete(session.sessionId);
      }
    };
  }

  emitEvent(sessionId: string, event: NormalizedHarnessEvent): void {
    this.listeners.get(sessionId)?.(event);
  }

  async discoverSessions() {
    return [];
  }
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (events: ChatStreamEvent[]) => boolean,
  timeoutMs = 2000,
): Promise<ChatStreamEvent[]> {
  const decoder = new TextDecoder();
  const events: ChatStreamEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(20, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          events.push(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
        } catch {
          // Ignore malformed SSE lines.
        }
      }
    }
    if (predicate(events)) break;
  }
  return events;
}

describe("Phase 6: Canonical Session Store & Full-Verbatim Cross-Harness Sync", () => {
  test("full-verbatim lazy delta sync across Claude -> AGY -> Claude -> OpenCode without duplicate turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p6-loop-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir, { recursive: true });

    try {
      const env = makeEnv(root);
      const claude = new StubHarnessAdapter("claude", "Claude CLI", "sonnet", ["sonnet", "opus"]);
      const agy = new StubHarnessAdapter("agy", "Antigravity CLI", "gemini-2.5-pro", [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ]);
      const opencode = new StubHarnessAdapter("opencode", "OpenCode", "anthropic/claude-sonnet-4-5", [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-4o",
      ]);

      const runner: TerminalRunnerPort = {
        isAvailable: async () => true,
        ensureSession: async ({ sessionId, tmuxSessionName }) => ({
          tmuxSession: tmuxSessionName ?? `cw-${sessionId.slice(0, 8)}`,
          isNew: true,
        }),
        sendPrompt: async () => {},
        sendRawKeys: async () => {},
        abortSession: async () => {},
        stopSession: async () => {},
        listActiveSessions: async () => [],
      };
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const registry = new HarnessRegistry([claude, agy, opencode]);
      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: projectDir });

      // 1. Start session in Claude and run 2 turns
      const s1Res = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "claude",
            model: "sonnet",
            cwd: projectDir,
            prompt: "Remember secret variable ALPHA_TOKEN = 4291 and rule: never use eval().",
          }),
        }),
      );
      expect(s1Res.status).toBe(202);
      const s1Body = (await s1Res.json()) as { ok: boolean; data: { session: SessionInfo } };
      const sessionId = s1Body.data.session.id;

      expect(claude.sentPrompts[0]?.prompt).toBe(
        "Remember secret variable ALPHA_TOKEN = 4291 and rule: never use eval().",
      );

      // Simulate Claude answering + editing a file
      claude.emitEvent(sessionId, {
        id: "cl-a1",
        type: "delta",
        role: "assistant",
        text: "Understood: ALPHA_TOKEN = 4291 and eval() is forbidden.",
        model: "sonnet",
        timestamp: "2026-11-13T10:00:01.000Z",
      });
      claude.emitEvent(sessionId, {
        id: "cl-t1",
        type: "tool",
        tool: "Edit",
        toolUseId: "tu-cl-1",
        toolInput: { file_path: join(projectDir, "config.ts") },
        text: "Edit: config.ts",
        model: "sonnet",
        timestamp: "2026-11-13T10:00:02.000Z",
      });
      claude.emitEvent(sessionId, {
        id: "cl-idle-1",
        type: "status",
        status: "idle",
        timestamp: "2026-11-13T10:00:03.000Z",
      });

      // 2. Switch Claude -> AGY (lazy: NO prompt sent to AGY yet!)
      const swAgyRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "agy" }),
        }),
      );
      expect(swAgyRes.status).toBe(200);
      const swAgy = (await swAgyRes.json()) as { ok: boolean; data: SwitchHarnessResponse };
      expect(swAgy.data.session.harnessId).toBe("agy");
      expect(swAgy.data.session.model).toBe("gemini-2.5-pro");
      expect(swAgy.data.sync.pendingSyncCount).toBe(3); // user1 + assistant1 + tool1
      expect(agy.sentPrompts.length).toBe(0);
      expect(agy.startCalls.length).toBe(0);

      // 3. Send next prompt on AGY -> triggers full-verbatim delta injection of turns 1..3
      const s2Res = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            prompt: "What was ALPHA_TOKEN and which file did we edit?",
          }),
        }),
      );
      expect(s2Res.status).toBe(202);
      expect(agy.sentPrompts.length).toBe(1);
      const agyInjected = agy.sentPrompts[0]!.prompt;
      expect(agyInjected).toContain("ALPHA_TOKEN = 4291");
      expect(agyInjected).toContain("never use eval()");
      expect(agyInjected).toContain("config.ts");
      expect(agyInjected).toContain("What was ALPHA_TOKEN and which file did we edit?");
      // Must use a distinct tmux session name so it never collides with Claude's tmux session
      expect(agy.startCalls[0]!.tmuxSessionName).not.toBe(claude.startCalls[0]!.tmuxSessionName);

      // Simulate AGY echoing the injected user prompt -> must be stripped & deduped!
      agy.emitEvent(sessionId, {
        id: "agy-echo-1",
        type: "user",
        role: "user",
        text: agyInjected,
        timestamp: "2026-11-13T10:01:00.000Z",
      });
      agy.emitEvent(sessionId, {
        id: "agy-a1",
        type: "delta",
        role: "assistant",
        text: "ALPHA_TOKEN is 4291 and config.ts was edited. I also updated auth.ts.",
        model: "gemini-2.5-pro",
        timestamp: "2026-11-13T10:01:02.000Z",
      });
      agy.emitEvent(sessionId, {
        id: "agy-t1",
        type: "tool",
        tool: "write_file",
        toolUseId: "tu-agy-1",
        toolInput: { TargetFile: join(projectDir, "auth.ts") },
        text: "write_file: auth.ts",
        model: "gemini-2.5-pro",
        timestamp: "2026-11-13T10:01:03.000Z",
      });
      agy.emitEvent(sessionId, {
        id: "agy-idle-1",
        type: "status",
        status: "idle",
        timestamp: "2026-11-13T10:01:04.000Z",
      });

      // 4. Switch back AGY -> Claude: Claude must ONLY receive AGY turns, NOT turns 1..3!
      const swClaudeRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "claude" }),
        }),
      );
      expect(swClaudeRes.status).toBe(200);
      const swClaude = (await swClaudeRes.json()) as { ok: boolean; data: SwitchHarnessResponse };
      // Claude already had seq 1..3, so only AGY turns (prompt2, agy-a1, agy-t1) should be pending!
      expect(swClaude.data.sync.pendingSyncCount).toBe(3);

      const s3Res = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            prompt: "Run tests on auth.ts now.",
          }),
        }),
      );
      expect(s3Res.status).toBe(202);
      expect(claude.sentPrompts.length).toBe(2);
      const claudeDeltaPrompt = claude.sentPrompts[1]!.prompt;
      // Contains AGY's edits & reply
      expect(claudeDeltaPrompt).toContain("I also updated auth.ts.");
      expect(claudeDeltaPrompt).toContain("auth.ts");
      expect(claudeDeltaPrompt).toContain("Run tests on auth.ts now.");
      // Does NOT re-send turn 1's rule/secret!
      expect(claudeDeltaPrompt).not.toContain("never use eval()");
      // Claude resumed its original externalSessionId
      expect(claude.startCalls[1]!.resumeSessionId).toBe(
        claude.startCalls[0]!.resumeSessionId ?? `claude-ext-${sessionId.slice(0, 6)}`,
      );

      claude.emitEvent(sessionId, {
        id: "cl-a2",
        type: "delta",
        role: "assistant",
        text: "All tests on auth.ts passed.",
        model: "sonnet",
        timestamp: "2026-11-13T10:02:01.000Z",
      });
      claude.emitEvent(sessionId, {
        id: "cl-idle-2",
        type: "status",
        status: "idle",
        timestamp: "2026-11-13T10:02:02.000Z",
      });

      // 5. Switch Claude -> OpenCode (completing the 3-harness loop)
      const swOcRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "opencode" }),
        }),
      );
      expect(swOcRes.status).toBe(200);
      const s4Res = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            prompt: "Summarize what Claude and AGY did.",
          }),
        }),
      );
      expect(s4Res.status).toBe(202);
      expect(opencode.sentPrompts.length).toBe(1);
      const ocInjected = opencode.sentPrompts[0]!.prompt;
      expect(ocInjected).toContain("ALPHA_TOKEN = 4291");
      expect(ocInjected).toContain("I also updated auth.ts.");
      expect(ocInjected).toContain("All tests on auth.ts passed.");

      // Verify canonical history has clean user prompts (zero sync preambles stored!) and switch markers
      const canonRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/canonical`),
      );
      expect(canonRes.status).toBe(200);
      const canonBody = (await canonRes.json()) as { ok: boolean; data: CanonicalSessionResponse };
      const userEvents = canonBody.data.events.filter((e) => e.role === "user");
      expect(userEvents.map((u) => u.text)).toEqual([
        "Remember secret variable ALPHA_TOKEN = 4291 and rule: never use eval().",
        "What was ALPHA_TOKEN and which file did we edit?",
        "Run tests on auth.ts now.",
        "Summarize what Claude and AGY did.",
      ]);
      const switchEvents = canonBody.data.events.filter((e) => e.kind === "harness_switched");
      expect(switchEvents.length).toBe(3);

      // 6. Restart apps/api -> verify SQLite canonical store + cursors + SSE replay survive restart!
      ctx.discovery.stop();
      ctx.canonicalRepo.close();

      const ctx2 = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: projectDir });
      await reconcilePersistedSessions(
        ctx2.sessions,
        ctx2.runner,
        ctx2.watcher,
        ctx2.eventBus,
        ctx2.coordinator,
        ctx2.fileChangeTracker,
        ctx2.agentTelemetry,
        ctx2.harnessGateway,
        ctx2.canonicalSync,
      );

      const canonAfterRestartRes = await ctx2.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/canonical`),
      );
      expect(canonAfterRestartRes.status).toBe(200);
      const canonAfterRestart = (await canonAfterRestartRes.json()) as {
        ok: boolean;
        data: CanonicalSessionResponse;
      };
      expect(canonAfterRestart.data.sync.activeHarness).toBe("opencode");
      expect(canonAfterRestart.data.sync.bindings.claude?.lastSyncedSeq).toBeGreaterThan(0);
      expect(canonAfterRestart.data.sync.bindings.agy?.lastSyncedSeq).toBeGreaterThan(0);
      expect(canonAfterRestart.data.sync.bindings.opencode?.lastSyncedSeq).toBe(
        canonAfterRestart.data.sync.latestSeq,
      );

      // SSE replay after restart emits unified timeline across all 3 harnesses + switch dividers
      const sseRes = await ctx2.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/events`),
      );
      const reader = sseRes.body!.getReader();
      const replayed = await readSseUntil(
        reader,
        (evts) => evts.filter((e) => e.type === "harness_switched").length >= 3,
        1500,
      );
      await reader.cancel();
      expect(replayed.some((e) => e.type === "user" && e.text?.includes("ALPHA_TOKEN"))).toBe(true);
      expect(replayed.some((e) => e.type === "delta" && e.harnessId === "agy")).toBe(true);
      expect(replayed.filter((e) => e.type === "harness_switched").length).toBe(3);

      ctx2.discovery.stop();
      ctx2.canonicalRepo.close();
      await ctx2.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("large-history File Sync fallback writes .harness-web/sync/<id>.md and avoids buffer truncation", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p6-filesync-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir, { recursive: true });

    try {
      const env = makeEnv(root, { syncByteThreshold: 512 });
      const claude = new StubHarnessAdapter("claude", "Claude CLI", "sonnet", ["sonnet"]);
      const agy = new StubHarnessAdapter("agy", "Antigravity CLI", "gemini-2.5-pro", ["gemini-2.5-pro"]);
      const registry = new HarnessRegistry([claude, agy]);
      const ctx = createApp({ env, harnessRegistry: registry, defaultCwd: projectDir });

      const send1 = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "claude",
            cwd: projectDir,
            prompt: "Analyze large log payload",
          }),
        }),
      );
      const sessionId = ((await send1.json()) as { data: { session: SessionInfo } }).data.session.id;

      // Emit > 512 bytes across multiple assistant events
      for (let i = 1; i <= 4; i++) {
        claude.emitEvent(sessionId, {
          id: `large-${i}`,
          type: "delta",
          role: "assistant",
          text: `Chunk #${i}: ` + "DETAILED_TRACE_LOG_ENTRY_".repeat(12),
          model: "sonnet",
          timestamp: `2026-11-13T11:00:0${i}.000Z`,
        });
      }
      claude.emitEvent(sessionId, {
        id: "large-idle",
        type: "status",
        status: "idle",
        timestamp: "2026-11-13T11:00:10.000Z",
      });

      const swRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "agy" }),
        }),
      );
      const swBody = (await swRes.json()) as { ok: boolean; data: SwitchHarnessResponse };
      expect(swBody.data.sync.largeContextWarning).toBe(true);

      const send2 = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            prompt: "Check Chunk #1 details.",
          }),
        }),
      );
      expect(send2.status).toBe(202);
      const send2Body = (await send2.json()) as { ok: boolean; data: { session: SessionInfo } };
      const syncSummary = send2Body.data.session.syncSummary!;
      expect(syncSummary.lastSyncStrategy).toBe("file_sync");
      expect(syncSummary.lastSyncFilePath).toMatch(/^\.harness-web\/sync\/.*\.md$/);

      const absSyncFile = join(projectDir, syncSummary.lastSyncFilePath!);
      expect(existsSync(absSyncFile)).toBe(true);
      const savedContent = readFileSync(absSyncFile, "utf8");
      expect(savedContent).toContain("Chunk #1:");
      expect(savedContent).toContain("Chunk #4:");
      expect(agy.sentPrompts[0]!.prompt).toContain(syncSummary.lastSyncFilePath!);
      expect(agy.sentPrompts[0]!.prompt).toContain("Check Chunk #1 details.");

      ctx.discovery.stop();
      ctx.canonicalRepo.close();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("external CLI session is auto-ingested into Canonical Store and can switch straight to OpenCode", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p6-ingest-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir, { recursive: true });

    try {
      const env = makeEnv(root);
      const encodedDir = projectDir.replace(/[^a-zA-Z0-9-]/g, "-");
      const claudeProjDir = join(env.claudeHome, "projects", encodedDir);
      mkdirSync(claudeProjDir, { recursive: true });

      const extCliId = "cli-ext-777";
      const transcriptPath = join(claudeProjDir, `${extCliId}.jsonl`);
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            uuid: "u-cli-1",
            cwd: projectDir,
            timestamp: "2026-11-13T12:00:00.000Z",
            message: { role: "user", content: "External CLI turn 1: DB port is 5439." },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "a-cli-1",
            timestamp: "2026-11-13T12:00:02.000Z",
            message: {
              role: "assistant",
              model: "sonnet",
              content: [{ type: "text", text: "Noted DB port 5439." }],
            },
          }),
        ].join("\n") + "\n",
      );

      const runner: TerminalRunnerPort = {
        isAvailable: async () => true,
        ensureSession: async ({ sessionId }) => ({
          tmuxSession: `cw-${sessionId.slice(0, 8)}`,
          isNew: true,
        }),
        sendPrompt: async () => {},
        sendRawKeys: async () => {},
        abortSession: async () => {},
        stopSession: async () => {},
        listActiveSessions: async () => [],
      };
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const claudeAdapter = new ClaudeHarnessAdapter({
        claudeHome: env.claudeHome,
        runner,
        watcher,
        defaultCwd: projectDir,
      });
      const opencode = new StubHarnessAdapter("opencode", "OpenCode", "anthropic/claude-sonnet-4-5", [
        "anthropic/claude-sonnet-4-5",
      ]);

      const importCalls: string[] = [];
      const opencodeImporter = new OpenCodeNativeImporterAdapter({
        enabled: true,
        exec: async (cmd) => {
          importCalls.push(cmd.join(" "));
          return { exitCode: 0, stdout: "imported\n", stderr: "" };
        },
      });

      const registry = new HarnessRegistry([claudeAdapter, opencode]);
      const ctx = createApp({
        env,
        runner,
        watcher,
        harnessRegistry: registry,
        opencodeImporter,
        defaultCwd: projectDir,
      });

      // Run external session discovery -> auto-ingests CLI turns into canonical store
      await ctx.discovery.scanOnce();

      const listRes = await ctx.app.handle(new Request("http://localhost/api/chat/sessions"));
      const listBody = (await listRes.json()) as { ok: boolean; data: { sessions: SessionInfo[] } };
      const discovered = listBody.data.sessions.find((s) => s.externalSessionId === extCliId)!;
      expect(discovered).toBeDefined();
      expect(discovered.origin).toBe("cli");
      expect(discovered.harnessId).toBe("claude");

      // Also simulate another turn happening in external CLI before user switches
      appendFileSync(
        transcriptPath,
        JSON.stringify({
          type: "user",
          uuid: "u-cli-2",
          cwd: projectDir,
          timestamp: "2026-11-13T12:00:05.000Z",
          message: { role: "user", content: "External CLI turn 2: Redis port is 6380." },
        }) +
          "\n" +
          JSON.stringify({
            type: "assistant",
            uuid: "a-cli-2",
            cwd: projectDir,
            timestamp: "2026-11-13T12:00:06.000Z",
            message: {
              role: "assistant",
              model: "claude-opus-4-6",
              content: [{ type: "text", text: "Noted Redis port 6380." }],
            },
          }) +
          "\n" +
          JSON.stringify({
            type: "result",
            uuid: "r-cli-2",
            timestamp: "2026-11-13T12:00:07.000Z",
            subtype: "success",
            result: "Done.",
          }) +
          "\n",
      );
      await new Promise((r) => setTimeout(r, 150));

      const canonBeforeSwitch = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${discovered.id}/canonical`),
      );
      const canonBeforeBody = (await canonBeforeSwitch.json()) as {
        ok: boolean;
        data: CanonicalSessionResponse;
      };
      expect(canonBeforeBody.data.events.some((e) => e.text?.includes("5439"))).toBe(true);
      expect(canonBeforeBody.data.events.some((e) => e.text?.includes("6380"))).toBe(true);

      // Switch external mirror CLI session directly to OpenCode and continue in Web!
      const swRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${discovered.id}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "opencode" }),
        }),
      );
      expect(swRes.status).toBe(200);
      const swBody = (await swRes.json()) as { ok: boolean; data: SwitchHarnessResponse };
      expect(swBody.data.session.controlMode).toBe("interactive");
      expect(swBody.data.session.harnessId).toBe("opencode");
      expect(swBody.data.sync.pendingSyncCount).toBeGreaterThanOrEqual(2);

      // Send prompt in OpenCode -> exercises OpenCodeNativeImporter (`opencode import <json>`)!
      const sendOc = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: discovered.id,
            prompt: "What are the DB and Redis ports?",
          }),
        }),
      );
      expect(sendOc.status).toBe(202);
      const sendOcBody = (await sendOc.json()) as { ok: boolean; data: { session: SessionInfo } };
      expect(importCalls.length).toBe(1);
      expect(importCalls[0]).toContain("opencode import");
      expect(sendOcBody.data.session.syncSummary?.lastSyncStrategy).toBe("opencode_import");
      expect(opencode.startCalls[0]!.resumeSessionId).toStartWith("oc_sync_");

      ctx.discovery.stop();
      ctx.canonicalRepo.close();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("regression: discovery dedup, stale hooks, first-time Claude switch --session-id, /model slash preservation, OpenCode chunk merge, adopted echo dedup, and restart backfill", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p6-regressions-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir, { recursive: true });

    try {
      const env = makeEnv(root);
      const claude = new StubHarnessAdapter("claude", "Claude CLI", "sonnet", ["sonnet", "opus"]);
      const agy = new StubHarnessAdapter("agy", "Antigravity CLI", "gemini-2.5-pro", [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ]);
      const opencode = new StubHarnessAdapter("opencode", "OpenCode", "anthropic/claude-sonnet-4-5", [
        "anthropic/claude-sonnet-4-5",
      ]);

      const runner: TerminalRunnerPort = {
        isAvailable: async () => true,
        ensureSession: async ({ sessionId, tmuxSessionName }) => ({
          tmuxSession: tmuxSessionName ?? `cw-${sessionId.slice(0, 8)}`,
          isNew: true,
        }),
        sendPrompt: async () => {},
        sendRawKeys: async () => {},
        abortSession: async () => {},
        stopSession: async () => {},
        listActiveSessions: async () => [],
      };

      const registry = new HarnessRegistry([claude, agy, opencode]);
      const ctx = createApp({ env, runner, harnessRegistry: registry });

      // (A) OpenCode -> Claude first time must NOT pass resumeSessionId (--resume fails on new Claude id)
      const ocCreate = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "opencode",
            model: "anthropic/claude-sonnet-4-5",
            cwd: projectDir,
            prompt: "Start in OpenCode",
          }),
        }),
      );
      expect(ocCreate.status).toBe(202);
      const ocSession = ((await ocCreate.json()) as { data: { session: SessionInfo } }).data.session;

      // (B) OpenCode chunked streaming deltas merge into ONE canonical assistant event
      opencode.emitEvent(ocSession.id, {
        id: "prt_100-0",
        type: "delta",
        role: "assistant",
        text: "Hello ",
        model: "anthropic/claude-sonnet-4-5",
        timestamp: "2026-11-13T13:00:01.000Z",
      });
      opencode.emitEvent(ocSession.id, {
        id: "prt_100-6",
        type: "delta",
        role: "assistant",
        text: "verbatim ",
        model: "anthropic/claude-sonnet-4-5",
        timestamp: "2026-11-13T13:00:02.000Z",
      });
      opencode.emitEvent(ocSession.id, {
        id: "prt_100-15",
        type: "delta",
        role: "assistant",
        text: "world!",
        model: "anthropic/claude-sonnet-4-5",
        timestamp: "2026-11-13T13:00:03.000Z",
      });
      opencode.emitEvent(ocSession.id, { type: "status", status: "idle" });

      // Simulate external ingest also returning full text part
      await ctx.externalIngest.ingestSession(ocSession, [
        {
          id: "prt_100-0",
          type: "delta",
          role: "assistant",
          text: "Hello verbatim world!",
          model: "anthropic/claude-sonnet-4-5",
          timestamp: "2026-11-13T13:00:03.000Z",
        },
      ]);

      const canonOc = ctx.canonicalSyncService.getCanonicalHistory(ocSession.id);
      const ocAssistantMsgs = canonOc!.events.filter((e) => e.role === "assistant" && e.kind === "message");
      expect(ocAssistantMsgs.length).toBe(1);
      expect(ocAssistantMsgs[0]!.text).toBe("Hello verbatim world!");

      // Switch OpenCode -> Claude first time
      const swClaude = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${ocSession.id}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "claude", model: "sonnet" }),
        }),
      );
      expect(swClaude.status).toBe(200);

      // (C) Sending `/model opus` after switch must NOT inject sync preamble and must leave delta pending
      const sendSlash = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: ocSession.id,
            prompt: "/model opus",
          }),
        }),
      );
      expect(sendSlash.status).toBe(202);
      expect(claude.startCalls[0]!.resumeSessionId).toBeUndefined();
      expect(claude.sentPrompts[0]!.prompt).toBe("/model opus");
      claude.emitEvent(ocSession.id, { type: "status", status: "idle" });

      // Now send a real prompt -> delta from OpenCode IS delivered verbatim!
      const sendAfterSlash = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: ocSession.id,
            prompt: "What did OpenCode say?",
          }),
        }),
      );
      expect(sendAfterSlash.status).toBe(202);
      expect(claude.sentPrompts[1]!.prompt).toContain("Hello verbatim world!");
      expect(claude.sentPrompts[1]!.prompt).not.toContain("/model opus");
      claude.emitEvent(ocSession.id, { type: "status", status: "idle" });

      // (D) Discovery dedup & stale hook isolation after switching external CLI session -> AGY
      const extDiscovered = await ctx.discovery["config"].discoverUsecase.execute({
        externalSessionId: "ext-dedup-cli-1",
        harnessId: "claude",
        transcriptPath: join(projectDir, "ext-dedup-cli-1.jsonl"),
        cwd: projectDir,
        origin: "cli",
        model: "claude-opus-4-6",
        lastMessagePreview: "CLI initial prompt",
        messageCount: 1,
      });

      await ctx.canonicalSyncService.ingestHistory(
        {
          sessionId: extDiscovered.id,
          harnessId: "claude",
          origin: "cli",
          controlMode: "mirror",
          cwd: projectDir,
          externalSessionId: "ext-dedup-cli-1",
          transcriptPath: join(projectDir, "ext-dedup-cli-1.jsonl"),
        },
        [
          {
            id: "u-ext-1",
            type: "user",
            role: "user",
            text: "CLI initial prompt",
            timestamp: "2026-11-13T13:01:00.000Z",
          },
        ],
        true,
      );

      const swAgy = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${extDiscovered.id}/switch-harness`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ harnessId: "agy" }),
        }),
      );
      expect(swAgy.status).toBe(200);

      // Re-discover the old Claude externalSessionId -> MUST NOT create duplicate session or revert harnessId!
      const rediscovered = await ctx.discovery["config"].discoverUsecase.execute({
        externalSessionId: "ext-dedup-cli-1",
        harnessId: "claude",
        transcriptPath: join(projectDir, "ext-dedup-cli-1.jsonl"),
        cwd: projectDir,
        origin: "cli",
        model: "claude-opus-4-6",
        lastMessagePreview: "CLI second prompt",
        messageCount: 2,
      });
      expect(rediscovered.id).toBe(extDiscovered.id);
      expect(rediscovered.harnessId).toBe("agy");

      const allSessionsRes = await ctx.app.handle(new Request("http://localhost/api/chat/sessions"));
      const allSessions = (
        (await allSessionsRes.json()) as { data: { sessions: SessionInfo[] } }
      ).data.sessions;
      expect(allSessions.filter((s) => s.cwd === projectDir).length).toBe(2);

      // Stale Claude SessionEnd hook referencing old externalSessionId MUST NOT stop the active AGY session
      const staleHook = await ctx.app.handle(
        new Request("http://localhost/api/chat/hooks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hook_event_name: "SessionEnd",
            harness_id: "claude",
            session_id: "ext-dedup-cli-1",
          }),
        }),
      );
      expect(staleHook.status).toBe(200);
      expect(ctx.sessions.get(extDiscovered.id)?.harnessId).toBe("agy");
      expect(ctx.sessions.get(extDiscovered.id)?.status).toBe("idle");

      // (E) Adopted external CLI session deduplicates web prompt echo on SSE
      const sseStreamRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${extDiscovered.id}/events`),
      );
      const sseReader = sseStreamRes.body!.getReader();
      await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: extDiscovered.id,
            prompt: "Adopted interactive prompt",
          }),
        }),
      );
      // Emit disk echo for the same prompt + assistant reply
      agy.emitEvent(extDiscovered.id, {
        id: "agy-u-echo",
        type: "user",
        role: "user",
        text: "<!-- harness-web-sync:from=1:to=1:strategy=direct_verbatim -->\n...\n<!-- /harness-web-sync -->\n\nAdopted interactive prompt",
        timestamp: "2026-11-13T13:02:01.000Z",
      });
      agy.emitEvent(extDiscovered.id, {
        id: "agy-a-echo",
        type: "delta",
        role: "assistant",
        text: "Adopted reply",
        timestamp: "2026-11-13T13:02:02.000Z",
      });
      agy.emitEvent(extDiscovered.id, { type: "status", status: "idle" });

      const sseEvents = await readSseUntil(
        sseReader,
        (evs) => evs.some((e) => e.type === "delta" && e.text === "Adopted reply"),
        1500,
      );
      await sseReader.cancel();
      const adoptedUserEvents = sseEvents.filter(
        (e) => e.type === "user" && e.text === "Adopted interactive prompt",
      );
      expect(adoptedUserEvents.length).toBe(1);

      // (F) Restart backfill with repeated "continue" web prompts does not duplicate earlier prompts
      const claudeTranscript = join(root, "restart-claude.jsonl");
      const claudeRestartId = "sess-restart-backfill";
      const watcher = new JsonlTranscriptWatcher();
      const restartClaude = new ClaudeHarnessAdapter({
        claudeHome: env.claudeHome,
        runner: runner as never,
        watcher,
      });

      const webSessionEnv = ctx.sessions.get(ocSession.id)!;
      // Cleanly test on a dedicated Claude session with real transcript file
      writeFileSync(
        claudeTranscript,
        [
          JSON.stringify({
            type: "user",
            uuid: "u-r-1",
            cwd: projectDir,
            timestamp: "2026-11-13T13:05:00.000Z",
            message: { role: "user", content: "continue" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "a-r-1",
            cwd: projectDir,
            timestamp: "2026-11-13T13:05:01.000Z",
            message: { role: "assistant", model: "sonnet", content: [{ type: "text", text: "ok 1" }] },
          }),
          JSON.stringify({
            type: "user",
            uuid: "u-r-2",
            cwd: projectDir,
            timestamp: "2026-11-13T13:05:02.000Z",
            message: { role: "user", content: "continue" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "a-r-2",
            cwd: projectDir,
            timestamp: "2026-11-13T13:05:03.000Z",
            message: { role: "assistant", model: "sonnet", content: [{ type: "text", text: "ok 2" }] },
          }),
        ].join("\n") + "\n",
      );

      // Simulate server state before restart (unkeyed web prompts matching transcript)
      ctx.canonicalSyncService.ensureSession({
        sessionId: claudeRestartId,
        harnessId: "claude",
        origin: "web",
        controlMode: "interactive",
        cwd: projectDir,
        transcriptPath: claudeTranscript,
      });
      ctx.canonicalRepo.appendEvent({
        canonicalSessionId: claudeRestartId,
        id: "ce-web-u1",
        harnessId: "claude",
        model: "sonnet",
        role: "user",
        kind: "message",
        text: "continue",
        ts: "2026-11-13T13:05:00.000Z",
      });
      ctx.canonicalRepo.appendEvent({
        canonicalSessionId: claudeRestartId,
        id: "ce-web-u2",
        harnessId: "claude",
        model: "sonnet",
        role: "user",
        kind: "message",
        text: "continue",
        ts: "2026-11-13T13:05:02.000Z",
      });
      ctx.sessions.save({
        ...webSessionEnv,
        id: claudeRestartId,
        harnessId: "claude",
        externalSessionId: undefined,
        tmuxSession: undefined,
        transcriptPath: claudeTranscript,
        status: "idle",
      });

      ctx.discovery.stop();
      ctx.canonicalRepo.close();
      await ctx.harnessRegistry.dispose();

      // Write an offline turn while server is "stopped"
      appendFileSync(
        claudeTranscript,
        JSON.stringify({
          type: "user",
          uuid: "u-r-3",
          cwd: projectDir,
          timestamp: "2026-11-13T13:06:00.000Z",
          message: { role: "user", content: "Offline prompt while API stopped" },
        }) + "\n",
      );

      const restarted = createApp({
        env,
        runner,
        harnessRegistry: new HarnessRegistry([restartClaude, agy, opencode]),
      });
      await reconcilePersistedSessions(
        restarted.sessions,
        restarted.runner,
        restarted.watcher,
        restarted.eventBus,
        restarted.coordinator,
        restarted.fileChangeTracker,
        restarted.agentTelemetry,
        restarted.harnessGateway,
        restarted.canonicalSync,
      );

      const backfilled = restarted.canonicalSyncService.getCanonicalHistory(claudeRestartId)!;
      const continueEvents = backfilled.events.filter(
        (e) => e.role === "user" && e.text === "continue",
      );
      expect(continueEvents.length).toBe(2);
      expect(
        backfilled.events.some((e) => e.text === "Offline prompt while API stopped"),
      ).toBe(true);

      restarted.discovery.stop();
      restarted.canonicalRepo.close();
      await restarted.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
