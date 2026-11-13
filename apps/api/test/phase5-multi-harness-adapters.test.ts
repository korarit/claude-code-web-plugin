import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatStreamEvent,
  HarnessesListResponse,
  SessionAgentsResponse,
  SessionChangesResponse,
  SessionInfo,
} from "@contracts/index";
import type { Env } from "../src/env.ts";
import { createApp } from "../src/index.ts";
import type { TerminalRunnerPort } from "../src/modules/chat/application/ports.ts";
import { JsonlTranscriptWatcher } from "../src/modules/chat/infrastructure/jsonl-watcher.ts";
import {
  AntigravityHarnessAdapter,
  buildAgyTmuxCommand,
} from "../src/modules/harness/infrastructure/agy-harness.adapter.ts";
import { ClaudeHarnessAdapter } from "../src/modules/harness/infrastructure/claude-harness.adapter.ts";
import { OpenCodeHarnessAdapter } from "../src/modules/harness/infrastructure/opencode-harness.adapter.ts";
import { HarnessRegistry } from "../src/modules/harness/application/harness-registry.ts";

function makeEnv(root: string): Env {
  return {
    port: 0,
    host: "127.0.0.1",
    harnessHome: join(root, "harness-web"),
    claudeHome: join(root, "claude"),
    agyCliHome: join(root, "agy-cli"),
    agyIdeHome: join(root, "agy-ide"),
    enableAgyIdeDiscovery: true,
    opencodeDataHome: join(root, "opencode-data"),
    token: "phase5-test-token",
    anthropicApiKey: undefined,
    concurrencySoftLimit: 5,
    opencodeServerUrl: undefined,
  };
}

function makeStubClaudeRunner(): TerminalRunnerPort {
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
    listActiveSessions: async () => [],
  };
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (events: ChatStreamEvent[]) => boolean,
  timeoutMs = 3000,
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

function createMockOpenCodeServer() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  const pushEvent = (payload: unknown) => {
    if (!sseController) return;
    sseController.enqueue(encoder.encode(`data: ${JSON.stringify({ payload })}\n\n`));
  };

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const parsedBody =
      typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body: parsedBody });

    if (url.pathname === "/global/health") {
      return Response.json({ healthy: true });
    }
    if (url.pathname === "/provider") {
      return Response.json({
        connected: ["openai", "anthropic"],
        all: [
          {
            id: "anthropic",
            models: { "claude-sonnet-4-5": {} },
          },
          {
            id: "openai",
            models: { "gpt-4o": {}, "o3-mini": {} },
          },
        ],
      });
    }
    if (url.pathname === "/agent") {
      return Response.json([{ name: "build" }, { name: "plan" }]);
    }
    if (url.pathname === "/session" && method === "POST") {
      return Response.json({
        id: "oc-ext-1",
        directory: parsedBody?.directory ?? "/tmp",
        title: parsedBody?.title ?? "OpenCode Session",
      });
    }
    if (url.pathname === "/session" && method === "GET") {
      return Response.json([]);
    }
    if (url.pathname === "/session/oc-ext-1/prompt_async" && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session/oc-ext-1/message" && method === "GET") {
      return Response.json([]);
    }
    if (url.pathname === "/session/oc-ext-1/abort" && method === "POST") {
      return Response.json(true);
    }
    if (url.pathname.startsWith("/permission/") && url.pathname.endsWith("/reply")) {
      return Response.json(true);
    }
    if (url.pathname.startsWith("/question/") && url.pathname.endsWith("/reply")) {
      return Response.json(true);
    }
    if (url.pathname === "/global/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseController = controller;
        },
        cancel() {
          sseController = null;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };

  return { fetchFn, pushEvent, calls };
}

describe("Phase 5: Multi-Harness Adapters", () => {
  test("GET /api/harnesses detects claude, agy, and opencode models, profiles, and capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p5-registry-"));
    try {
      const env = makeEnv(root);
      mkdirSync(env.claudeHome, { recursive: true });
      mkdirSync(join(env.agyIdeHome!, "agents"), { recursive: true });
      writeFileSync(
        join(env.agyIdeHome!, "agents", "architect.md"),
        "# Architect agent profile\n",
      );

      const runner = makeStubClaudeRunner();
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const mockOc = createMockOpenCodeServer();

      const claudeAdapter = new ClaudeHarnessAdapter({
        claudeHome: env.claudeHome,
        runner,
        watcher,
        defaultCwd: root,
        exec: async (cmd) => {
          if (cmd[0] === "which" && cmd[1] === "claude") {
            return { exitCode: 0, stdout: "/usr/local/bin/claude\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      });
      const agyAdapter = new AntigravityHarnessAdapter({
        agyCliHome: env.agyCliHome,
        agyIdeHome: env.agyIdeHome,
        enableIdeDiscovery: true,
        exec: async (cmd) => {
          if (cmd[0] === "which" && cmd[1] === "agy") {
            return { exitCode: 0, stdout: "/usr/local/bin/agy\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      });
      const opencodeAdapter = new OpenCodeHarnessAdapter({
        opencodeDataHome: env.opencodeDataHome,
        externalServerUrl: "http://opencode.local:4096",
        fetchFn: mockOc.fetchFn,
        exec: async (cmd) => {
          if (cmd[0] === "which" && cmd[1] === "opencode") {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      });

      const registry = new HarnessRegistry([claudeAdapter, agyAdapter, opencodeAdapter]);
      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: root });

      const res = await ctx.app.handle(new Request("http://localhost/api/harnesses"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: HarnessesListResponse };
      expect(body.ok).toBe(true);
      expect(body.data.harnesses.length).toBe(3);

      const claude = body.data.harnesses.find((h) => h.id === "claude")!;
      expect(claude.available).toBe(true);
      expect(claude.models).toEqual(["sonnet", "opus", "haiku"]);
      expect(claude.capabilities.hooks).toBe(true);

      const agy = body.data.harnesses.find((h) => h.id === "agy")!;
      expect(agy.available).toBe(true);
      expect(agy.agentProfiles).toContain("architect");
      expect(agy.capabilities.jsonlTranscript).toBe(true);

      const oc = body.data.harnesses.find((h) => h.id === "opencode")!;
      expect(oc.available).toBe(true);
      expect(oc.models).toContain("openai/gpt-4o");
      expect(oc.models).toContain("anthropic/claude-sonnet-4-5");
      expect(oc.agentProfiles).toEqual(["build", "plan"]);
      expect(oc.capabilities.serverApi).toBe(true);

      ctx.discovery.stop();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("AGY session streams transcript, invokes subagents, tracks changes, and handles blocking PreToolUse", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p5-agy-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "app.ts"), "export const v = 1;\n");

    try {
      const env = makeEnv(root);
      const tmuxCmds: string[][] = [];
      let tmuxCreated = false;

      // Verify exact CLI flags generated for AGY tmux launch.
      expect(
        buildAgyTmuxCommand({
          model: "gemini-2.5-pro",
          resumeSessionId: "agy-conv-99",
          agentProfile: "reviewer",
        }),
      ).toContain("'--conversation' 'agy-conv-99'");

      const agyAdapter = new AntigravityHarnessAdapter({
        agyCliHome: env.agyCliHome,
        agyIdeHome: env.agyIdeHome,
        enableIdeDiscovery: false,
        agyBin: "agy",
        tmuxBin: "tmux",
        bootTimeoutMs: 50,
        pollIntervalMs: 40,
        exec: async (cmd) => {
          tmuxCmds.push(cmd);
          if (cmd[0] === "which") {
            return { exitCode: 0, stdout: `/usr/local/bin/${cmd[1]}\n`, stderr: "" };
          }
          if (cmd[1] === "has-session") {
            return { exitCode: tmuxCreated ? 0 : 1, stdout: "", stderr: "" };
          }
          if (cmd[1] === "new-session") {
            tmuxCreated = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (cmd[1] === "capture-pane") {
            return { exitCode: 0, stdout: "Type a message >\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      const runner = makeStubClaudeRunner();
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const registry = new HarnessRegistry([
        new ClaudeHarnessAdapter({ claudeHome: env.claudeHome, runner, watcher, defaultCwd: projectDir }),
        agyAdapter,
      ]);

      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: projectDir });

      // 1. Start AGY session via POST /api/chat/send
      const sendRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "agy",
            model: "gemini-2.5-pro",
            cwd: projectDir,
            agentProfile: "reviewer",
            prompt: "Update app.ts and inspect subagent",
          }),
        }),
      );
      expect(sendRes.status).toBe(202);
      const sendData = (await sendRes.json()) as {
        ok: boolean;
        data: { session: SessionInfo; isNewSession: boolean };
      };
      expect(sendData.ok).toBe(true);
      const sessionId = sendData.data.session.id;
      expect(sendData.data.session.harnessId).toBe("agy");
      expect(sendData.data.session.model).toBe("gemini-2.5-pro");

      // Verify tmux new-session received AGY_WEB_SESSION_ID, HARNESS_WAIT_PRETOOLUSE=1, and --agent 'reviewer'
      const newSessionCmd = tmuxCmds.find((c) => c[1] === "new-session");
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd!.join(" ")).toContain(`AGY_WEB_SESSION_ID=${sessionId}`);
      expect(newSessionCmd!.join(" ")).toContain("HARNESS_WAIT_PRETOOLUSE=1");
      expect(newSessionCmd!.join(" ")).toContain("'--agent' 'reviewer'");

      // 2. Attach transcript path via AGY SessionStart hook & write real AGY steps
      const mainConvId = "agy-main-conv-1";
      const mainTranscript = join(
        env.agyCliHome,
        "brain",
        mainConvId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      mkdirSync(join(env.agyCliHome, "brain", mainConvId, ".system_generated", "logs"), {
        recursive: true,
      });

      const subConvId = "agy-sub-conv-1";
      const subTranscript = join(
        env.agyCliHome,
        "brain",
        subConvId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      mkdirSync(join(env.agyCliHome, "brain", subConvId, ".system_generated", "logs"), {
        recursive: true,
      });

      const startHookRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/hooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": env.token,
            "X-Agy-Web-Session-Id": sessionId,
            "X-Harness-Id": "agy",
          },
          body: JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: mainConvId,
            cwd: projectDir,
            transcript_path: mainTranscript,
          }),
        }),
      );
      expect(startHookRes.status).toBe(200);

      // 3. Test blocking PreToolUse (HARNESS_WAIT_PRETOOLUSE=1) + allow_once resolution
      const targetFile = join(projectDir, "app.ts");
      const blockingHookPromise = ctx.app.handle(
        new Request("http://localhost/api/chat/hooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": env.token,
            "X-Agy-Web-Session-Id": sessionId,
            "X-Harness-Id": "agy",
            "X-Harness-Wait-Decision": "1",
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: mainConvId,
            tool_name: "write_file",
            tool_use_id: "agy-tu-write-1",
            tool_input: { TargetFile: targetFile, Content: "export const v = 2;\n" },
          }),
        }),
      );

      // Wait briefly for pendingInteraction to be registered on session
      await new Promise((r) => setTimeout(r, 80));
      const waitingSessionRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/sessions"),
      );
      const waitingSessionBody = (await waitingSessionRes.json()) as {
        ok: boolean;
        data: { sessions: SessionInfo[] };
      };
      const waitingSession = waitingSessionBody.data.sessions.find((s) => s.id === sessionId)!;
      expect(waitingSession.status).toBe("waiting_permission");
      expect(waitingSession.pendingInteraction?.kind).toBe("permission");
      expect(waitingSession.pendingInteraction?.commandOrTarget).toBe(targetFile);

      // Approve from web UI -> unblocks AGY PreToolUse with decision: "auto_approve"
      const inputRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            interactionId: waitingSession.pendingInteraction!.id,
            inputType: "decision",
            value: "allow_once",
          }),
        }),
      );
      expect(inputRes.status).toBe(200);

      const resolvedHookRes = await blockingHookPromise;
      expect(resolvedHookRes.status).toBe(200);
      const resolvedHookJson = (await resolvedHookRes.json()) as {
        ok: boolean;
        data?: {
          decision?: string;
          hookOutput?: {
            decision?: string;
            hookSpecificOutput?: { permissionDecision?: string };
          };
        };
      };
      expect(resolvedHookJson.data?.decision).toBe("allow_once");
      expect(resolvedHookJson.data?.hookOutput?.decision).toBe("auto_approve");
      expect(resolvedHookJson.data?.hookOutput?.hookSpecificOutput?.permissionDecision).toBe("allow");

      // Simulate AGY writing the file and PostToolUse firing
      writeFileSync(targetFile, "export const v = 2;\n");
      const postHookRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/hooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Harness-Token": env.token,
            "X-Agy-Web-Session-Id": sessionId,
            "X-Harness-Id": "agy",
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            session_id: mainConvId,
            tool_name: "write_file",
            tool_use_id: "agy-tu-write-1",
            tool_input: { TargetFile: targetFile },
          }),
        }),
      );
      expect(postHookRes.status).toBe(200);

      // Verify ChangesDrawer backend records change attributed to harnessId: "agy" & "gemini-2.5-pro"
      const changesRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/changes`),
      );
      const changesBody = (await changesRes.json()) as { ok: boolean; data: SessionChangesResponse };
      expect(changesBody.data.files.some((f) => f.path === "app.ts")).toBe(true);
      const appFile = changesBody.data.files.find((f) => f.path === "app.ts")!;
      expect(appFile.lastEditedBy.harnessId).toBe("agy");
      expect(appFile.lastEditedBy.model).toBe("gemini-2.5-pro");

      // 4. Open SSE stream and append real AGY transcript lines including invoke_subagent
      const sseRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/events`),
      );
      const reader = sseRes.body!.getReader();

      writeFileSync(
        subTranscript,
        [
          JSON.stringify({
            step_index: 0,
            type: "USER_INPUT",
            content: "<USER_REQUEST>\nReview app.ts\n</USER_REQUEST>",
            created_at: new Date().toISOString(),
          }),
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            content: "Subagent verified app.ts exports v = 2.",
            created_at: new Date().toISOString(),
          }),
        ].join("\n") + "\n",
      );

      appendFileSync(
        mainTranscript,
        [
          JSON.stringify({
            step_index: 0,
            type: "USER_INPUT",
            content: `Active Workspaces:\n- ${projectDir}\n<USER_REQUEST>\nUpdate app.ts and inspect subagent\n</USER_REQUEST>`,
            created_at: new Date().toISOString(),
          }),
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            content: "Delegating verification to subagent.",
            model: "gemini-2.5-pro",
            input_tokens: 150,
            output_tokens: 45,
            tool_calls: [
              {
                id: "agy-sub-call-1",
                name: "invoke_subagent",
                args: { Role: "Code Reviewer", TypeName: "research" },
              },
            ],
            created_at: new Date().toISOString(),
          }),
          JSON.stringify({
            step_index: 2,
            type: "TOOL_RESULT",
            status: "DONE",
            content: `Launched conversation://${subConvId}`,
            created_at: new Date().toISOString(),
          }),
        ].join("\n") + "\n",
      );

      const events = await readSseUntil(
        reader,
        (evts) =>
          evts.some((e) => e.type === "delta" && e.text?.includes("Delegating verification")) &&
          evts.some((e) => e.type === "agent_updated" && e.agent?.agentId === "agy-sub-call-1"),
        2500,
      );
      await reader.cancel();

      expect(events.some((e) => e.type === "delta" && e.text?.includes("Delegating verification"))).toBe(true);
      expect(events.some((e) => e.type === "agent_updated" && e.agent?.role === "Code Reviewer")).toBe(true);

      // Verify agents endpoint & subagent drill-down events through AgyHarnessAdapter
      const agentsRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/agents`),
      );
      const agentsBody = (await agentsRes.json()) as { ok: boolean; data: SessionAgentsResponse };
      expect(agentsBody.data.agents.some((a) => a.agentId === "agy-sub-call-1")).toBe(true);

      const subEventsRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/agents/agy-sub-call-1/events`),
      );
      expect(subEventsRes.status).toBe(200);
      const subReader = subEventsRes.body!.getReader();
      const subEvents = await readSseUntil(
        subReader,
        (evts) => evts.some((e) => e.type === "delta" && e.text?.includes("Subagent verified app.ts")),
        1500,
      );
      await subReader.cancel();
      expect(
        subEvents.some((e) => e.type === "delta" && e.text?.includes("Subagent verified app.ts")),
      ).toBe(true);

      // 5. Verify resume on AGY session works cleanly
      tmuxCreated = false;
      const resumeRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gemini-2.5-flash" }),
        }),
      );
      expect(resumeRes.status).toBe(200);

      ctx.discovery.stop();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("OpenCode session streams SSE events, resolves REST permission & question, tracks changes, and maps subagents", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p5-opencode-"));
    const projectDir = join(root, "oc-repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "server.ts"), "export const port = 3000;\n");

    try {
      const env = makeEnv(root);
      const mockOc = createMockOpenCodeServer();
      const opencodeAdapter = new OpenCodeHarnessAdapter({
        opencodeDataHome: env.opencodeDataHome,
        externalServerUrl: "http://opencode.local:4096",
        fetchFn: mockOc.fetchFn,
      });
      const runner = makeStubClaudeRunner();
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const registry = new HarnessRegistry([
        new ClaudeHarnessAdapter({ claudeHome: env.claudeHome, runner, watcher, defaultCwd: projectDir }),
        opencodeAdapter,
      ]);
      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: projectDir });

      // 1. Start OpenCode session & send prompt
      const sendRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "opencode",
            model: "openai/gpt-4o",
            cwd: projectDir,
            prompt: "Refactor server.ts port",
          }),
        }),
      );
      expect(sendRes.status).toBe(202);
      const sendBody = (await sendRes.json()) as {
        ok: boolean;
        data: { session: SessionInfo };
      };
      const sessionId = sendBody.data.session.id;
      expect(sendBody.data.session.harnessId).toBe("opencode");
      expect(sendBody.data.session.externalSessionId).toBe("oc-ext-1");
      expect(
        mockOc.calls.some((c) => c.method === "POST" && c.path === "/session/oc-ext-1/prompt_async"),
      ).toBe(true);

      // Give SSE observer microtask time to connect to /global/event
      await new Promise((r) => setTimeout(r, 40));

      const sseRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/events`),
      );
      const reader = sseRes.body!.getReader();

      // 2. Push OpenCode events: assistant message, text part, edit tool, child subagent, permission, question
      mockOc.pushEvent({
        type: "message.updated",
        properties: {
          info: { id: "msg-a1", sessionID: "oc-ext-1", role: "assistant", modelID: "openai/gpt-4o" },
        },
      });
      mockOc.pushEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-text-1",
            sessionID: "oc-ext-1",
            messageID: "msg-a1",
            type: "text",
            text: "Updating server port now.",
          },
        },
      });
      mockOc.pushEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            sessionID: "oc-ext-1",
            messageID: "msg-a1",
            type: "tool",
            tool: "edit",
            callID: "oc-call-edit-1",
            state: {
              status: "running",
              input: { filePath: join(projectDir, "server.ts") },
            },
          },
        },
      });
      // Edit file before completed tool event triggers snapshot diff capture
      writeFileSync(join(projectDir, "server.ts"), "export const port = 8080;\n");
      mockOc.pushEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-tool-1",
            sessionID: "oc-ext-1",
            messageID: "msg-a1",
            type: "tool",
            tool: "edit",
            callID: "oc-call-edit-1",
            state: {
              status: "completed",
              input: { filePath: join(projectDir, "server.ts") },
            },
          },
        },
      });
      // Child subagent session created under oc-ext-1
      mockOc.pushEvent({
        type: "session.created",
        properties: {
          info: { id: "oc-child-1", parentID: "oc-ext-1", title: "Explore Agent" },
        },
      });
      // OpenCode permission request
      mockOc.pushEvent({
        type: "permission.asked",
        properties: {
          id: "perm-oc-1",
          sessionID: "oc-ext-1",
          permission: "bash",
          patterns: ["bun test"],
        },
      });

      const events1 = await readSseUntil(
        reader,
        (evts) =>
          evts.some((e) => e.type === "delta" && e.text?.includes("Updating server port")) &&
          evts.some((e) => e.type === "agent_updated" && e.agent?.agentId === "oc-child-1") &&
          evts.some((e) => e.type === "interaction" && e.interaction?.id === "perm-oc-1"),
        2000,
      );
      expect(events1.some((e) => e.type === "delta")).toBe(true);
      expect(events1.some((e) => e.type === "agent_updated" && e.agent?.role === "Explore Agent")).toBe(
        true,
      );

      // 3. Reply to OpenCode permission from Web UI -> forwards REST /permission/perm-oc-1/reply { reply: "once" }
      const permReplyRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            interactionId: "perm-oc-1",
            inputType: "decision",
            value: "allow_once",
          }),
        }),
      );
      expect(permReplyRes.status).toBe(200);
      expect(
        mockOc.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === "/permission/perm-oc-1/reply" &&
            (c.body as { reply?: string })?.reply === "once",
        ),
      ).toBe(true);

      // 4. Push OpenCode question & answer via Web UI -> forwards REST /question/q-oc-1/reply { answers }
      mockOc.pushEvent({
        type: "question.asked",
        properties: {
          id: "q-oc-1",
          sessionID: "oc-ext-1",
          questions: [
            {
              header: "Storage",
              question: "Which database engine?",
              options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
            },
          ],
        },
      });
      await readSseUntil(
        reader,
        (evts) => evts.some((e) => e.type === "interaction" && e.interaction?.id === "q-oc-1"),
        1500,
      );

      const qReplyRes = await ctx.app.handle(
        new Request("http://localhost/api/chat/input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            interactionId: "q-oc-1",
            inputType: "selection",
            value: { Storage: "PostgreSQL" },
          }),
        }),
      );
      expect(qReplyRes.status).toBe(200);
      await reader.cancel();

      const qCall = mockOc.calls.find(
        (c) => c.method === "POST" && c.path === "/question/q-oc-1/reply",
      );
      expect(qCall).toBeDefined();
      expect((qCall!.body as { answers?: string[][] })?.answers).toEqual([["PostgreSQL"]]);

      // Verify OpenCode file changes recorded in ChangesDrawer API with harnessId: "opencode"
      await new Promise((r) => setTimeout(r, 40));
      const changesRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${sessionId}/changes`),
      );
      const changesBody = (await changesRes.json()) as { ok: boolean; data: SessionChangesResponse };
      const srv = changesBody.data.files.find((f) => f.path === "server.ts");
      expect(srv).toBeDefined();
      expect(srv!.lastEditedBy.harnessId).toBe("opencode");
      expect(srv!.lastEditedBy.model).toBe("openai/gpt-4o");

      ctx.discovery.stop();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("External session discovery finds Claude, AGY CLI + IDE mirror, and OpenCode SQLite and filters by ?harness=", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p5-discover-"));
    try {
      const env = makeEnv(root);

      // 1. Seed external Claude JSONL transcript
      const claudeProj = join(env.claudeHome, "projects", "-tmp-claude-ext");
      mkdirSync(claudeProj, { recursive: true });
      writeFileSync(
        join(claudeProj, "claude-ext-1.jsonl"),
        JSON.stringify({
          type: "user",
          sessionId: "claude-ext-1",
          cwd: "/tmp/claude-ext",
          message: { role: "user", content: "Inspect Claude external session", model: "sonnet" },
        }) + "\n",
      );

      // 2. Seed external AGY CLI transcript + AGY IDE mirror transcript
      const agyCliLogs = join(env.agyCliHome, "brain", "agy-cli-ext-1", ".system_generated", "logs");
      mkdirSync(agyCliLogs, { recursive: true });
      writeFileSync(
        join(agyCliLogs, "transcript.jsonl"),
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content:
            "Active Workspaces:\n- /tmp/agy-cli-ext\n<USER_REQUEST>\nFix AGY parser bug\n</USER_REQUEST>",
          created_at: new Date().toISOString(),
        }) + "\n",
      );

      const agyIdeLogs = join(env.agyIdeHome!, "brain", "agy-ide-ext-1", ".system_generated", "logs");
      mkdirSync(agyIdeLogs, { recursive: true });
      writeFileSync(
        join(agyIdeLogs, "transcript.jsonl"),
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content:
            "Active Workspaces:\n- /tmp/agy-ide-ext\n<USER_REQUEST>\nIDE Antigravity task\n</USER_REQUEST>",
          created_at: new Date().toISOString(),
        }) + "\n",
      );

      // 3. Seed external OpenCode SQLite DB (session + message + part for offline history)
      mkdirSync(env.opencodeDataHome, { recursive: true });
      const db = new Database(join(env.opencodeDataHome, "opencode.db"));
      db.run(
        `CREATE TABLE session (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          directory TEXT,
          title TEXT,
          time_updated INTEGER
        )`,
      );
      db.run(
        `CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        )`,
      );
      db.run(
        `CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        )`,
      );
      db.run(
        `INSERT INTO session (id, parent_id, directory, title, time_updated) VALUES (?, NULL, ?, ?, ?)`,
        ["oc-sqlite-1", "/tmp/oc-ext", "OpenCode SQLite Task", Date.now()],
      );
      db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`, [
        "oc-msg-1",
        "oc-sqlite-1",
        Date.now() - 1000,
        JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-4o" }),
      ]);
      db.run(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`, [
        "oc-part-1",
        "oc-msg-1",
        "oc-sqlite-1",
        Date.now() - 900,
        JSON.stringify({ type: "text", text: "Restored OpenCode SQLite offline history." }),
      ]);
      db.close();

      const runner = makeStubClaudeRunner();
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const registry = new HarnessRegistry([
        new ClaudeHarnessAdapter({
          claudeHome: env.claudeHome,
          runner,
          watcher,
          defaultCwd: root,
          exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        }),
        new AntigravityHarnessAdapter({
          agyCliHome: env.agyCliHome,
          agyIdeHome: env.agyIdeHome,
          enableIdeDiscovery: true,
          exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
        }),
        new OpenCodeHarnessAdapter({
          opencodeDataHome: env.opencodeDataHome,
          exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
          fetchFn: async () => new Response("offline", { status: 503 }),
        }),
      ]);

      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: root });
      await ctx.discovery.scanOnce();

      const allRes = await ctx.app.handle(new Request("http://localhost/api/chat/sessions"));
      const allBody = (await allRes.json()) as { ok: boolean; data: { sessions: SessionInfo[] } };
      const list = allBody.data.sessions;

      expect(list.some((s) => s.harnessId === "claude" && s.externalSessionId === "claude-ext-1")).toBe(
        true,
      );
      expect(
        list.some(
          (s) =>
            s.harnessId === "agy" &&
            s.externalSessionId === "agy-cli-ext-1" &&
            s.origin === "cli",
        ),
      ).toBe(true);
      expect(
        list.some(
          (s) =>
            s.harnessId === "agy" &&
            s.externalSessionId === "agy-ide-ext-1" &&
            s.origin === "ide" &&
            s.controlMode === "mirror",
        ),
      ).toBe(true);
      expect(
        list.some(
          (s) =>
            s.harnessId === "opencode" &&
            s.externalSessionId === "oc-sqlite-1" &&
            s.title === "OpenCode SQLite Task",
        ),
      ).toBe(true);

      // Verify offline OpenCode SQLite message/part history replays via GET /api/chat/sessions/:id/events
      const ocSession = list.find((s) => s.externalSessionId === "oc-sqlite-1")!;
      const ocHistoryRes = await ctx.app.handle(
        new Request(`http://localhost/api/chat/sessions/${ocSession.id}/events`),
      );
      const ocHistoryReader = ocHistoryRes.body!.getReader();
      const ocHistoryEvents = await readSseUntil(
        ocHistoryReader,
        (evts) =>
          evts.some(
            (e) => e.type === "delta" && e.text?.includes("Restored OpenCode SQLite offline history"),
          ),
        1200,
      );
      await ocHistoryReader.cancel();
      expect(
        ocHistoryEvents.some(
          (e) => e.type === "delta" && e.text?.includes("Restored OpenCode SQLite offline history"),
        ),
      ).toBe(true);

      // Verify ?harness= filtering on GET /api/chat/sessions
      for (const hid of ["claude", "agy", "opencode"] as const) {
        const filteredRes = await ctx.app.handle(
          new Request(`http://localhost/api/chat/sessions?harness=${hid}`),
        );
        const filteredBody = (await filteredRes.json()) as {
          ok: boolean;
          data: { sessions: SessionInfo[] };
        };
        expect(filteredBody.data.sessions.length).toBeGreaterThanOrEqual(1);
        expect(filteredBody.data.sessions.every((s) => s.harnessId === hid)).toBe(true);
      }

      ctx.discovery.stop();
      await ctx.harnessRegistry.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HTTP integration: hook-forwarder.sh blocks AGY PreToolUse with HARNESS_WAIT_PRETOOLUSE=1 until Web UI approves", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p5-hook-e2e-"));
    try {
      const env = makeEnv(root);
      const runner = makeStubClaudeRunner();
      const watcher = new JsonlTranscriptWatcher(env.claudeHome);
      const agyAdapter = new AntigravityHarnessAdapter({
        agyCliHome: env.agyCliHome,
        agyIdeHome: env.agyIdeHome,
        enableIdeDiscovery: false,
        agyBin: "agy",
        tmuxBin: "tmux",
        bootTimeoutMs: 20,
        pollIntervalMs: 20,
        exec: async (cmd) => {
          if (cmd[0] === "which") return { exitCode: 0, stdout: "/usr/local/bin/agy\n", stderr: "" };
          if (cmd[1] === "has-session") return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      const registry = new HarnessRegistry([
        new ClaudeHarnessAdapter({ claudeHome: env.claudeHome, runner, watcher, defaultCwd: root }),
        agyAdapter,
      ]);

      const ctx = createApp({ env, runner, watcher, harnessRegistry: registry, defaultCwd: root });
      ctx.app.listen({ hostname: "127.0.0.1", port: 0 });
      const actualPort = ctx.app.server!.port;

      try {
        const sendRes = await fetch(`http://127.0.0.1:${actualPort}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "agy",
            model: "gemini-2.5-pro",
            cwd: root,
            prompt: "Run command",
          }),
        });
        const sendBody = (await sendRes.json()) as {
          ok: boolean;
          data: { session: SessionInfo };
        };
        const sessionId = sendBody.data.session.id;

        const scriptPath = join(
          import.meta.dir,
          "../../../plugins/web/scripts/hook-forwarder.sh",
        );
        const proc = Bun.spawn(["bash", scriptPath], {
          stdin: new TextEncoder().encode(
            JSON.stringify({
              hook_event_name: "PreToolUse",
              session_id: "agy-e2e-1",
              tool_name: "run_command",
              tool_input: { CommandLine: "echo hi" },
            }),
          ),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            CLAUDE_WEB_PORT: String(actualPort),
            CLAUDE_WEB_TOKEN: env.token,
            AGY_WEB_SESSION_ID: sessionId,
            HARNESS_WAIT_PRETOOLUSE: "1",
          },
        });

        // Wait for hook-forwarder.sh to register waiting_permission on the server
        let pendingId: string | undefined;
        for (let i = 0; i < 30; i++) {
          const sRes = await fetch(`http://127.0.0.1:${actualPort}/api/chat/sessions`);
          const sBody = (await sRes.json()) as { ok: boolean; data: { sessions: SessionInfo[] } };
          const found = sBody.data.sessions.find((s) => s.id === sessionId);
          if (found?.status === "waiting_permission" && found.pendingInteraction) {
            expect(found.pendingInteraction.commandOrTarget).toBe("echo hi");
            pendingId = found.pendingInteraction.id;
            break;
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        expect(pendingId).toBeDefined();

        const approveRes = await fetch(`http://127.0.0.1:${actualPort}/api/chat/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            interactionId: pendingId,
            inputType: "decision",
            value: "allow_once",
          }),
        });
        expect(approveRes.status).toBe(200);

        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        expect(exitCode).toBe(0);
        expect(stdout.trim()).not.toBe("");
        const parsed = JSON.parse(stdout.trim()) as {
          decision?: string;
          hookSpecificOutput?: { permissionDecision?: string };
        };
        expect(parsed.decision).toBe("auto_approve");
        expect(parsed.hookSpecificOutput?.permissionDecision).toBe("allow");
      } finally {
        ctx.discovery.stop();
        await ctx.harnessRegistry.dispose();
        await ctx.app.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
