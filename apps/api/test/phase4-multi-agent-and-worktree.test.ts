import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AllAgentsResponse,
  ChatStreamEvent,
  CreateWorktreeResponse,
  FileDiffResponse,
  ListWorktreesResponse,
  MergeWorktreeResponse,
  RemoveWorktreeResponse,
  SessionAgentsResponse,
  SessionChangesResponse,
  SessionInfo,
} from "@contracts/index";
import { createApp } from "../src/index.ts";
import type { TerminalRunnerPort } from "../src/modules/chat/application/ports.ts";

function makeStubRunner(): TerminalRunnerPort {
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

function execGitSync(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr)}`);
  }
  return new TextDecoder().decode(res.stdout).trim();
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (events: ChatStreamEvent[]) => boolean,
  timeoutMs = 2500,
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
    if (!chunk) break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          try {
            events.push(JSON.parse(raw) as ChatStreamEvent);
          } catch {
            // Ignore malformed SSE lines.
          }
        }
      }
    }
    if (predicate(events)) break;
  }

  return events;
}

describe("Phase 4: Multi-Agent Visibility & Worktree Dashboard", () => {
  test("tracks SubagentStart/SubagentStop, tails agent transcript SSE, and syncs Shared Task Board", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p4-agents-"));
    const repoDir = join(root, "repo");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });

    try {
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p4-token",
        },
        runner: makeStubRunner(),
        defaultCwd: repoDir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        // 1. Create main session
        const sendRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Run parallel research", model: "sonnet", cwd: repoDir }),
        });
        expect(sendRes.status).toBe(202);
        const sessionId = ((await sendRes.json()) as { data: { session: { id: string } } }).data
          .session.id;

        // Subscribe to main session SSE
        const mainCtrl = new AbortController();
        const mainSse = await fetch(`${base}/api/chat/sessions/${sessionId}/events`, {
          signal: mainCtrl.signal,
        });
        expect(mainSse.status).toBe(200);
        const mainReader = mainSse.body!.getReader();

        // 2. Write initial line to subagent 1 transcript and fire SubagentStart hooks for 2 subagents
        const sub1Path = join(root, "agent-sub-1.jsonl");
        const sub2Path = join(root, "agent-sub-2.jsonl");
        writeFileSync(
          sub1Path,
          `${JSON.stringify({
            type: "assistant",
            uuid: "s1-a1",
            timestamp: "2026-11-13T21:00:00Z",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Inspecting codebase routes first." },
                {
                  type: "tool_use",
                  id: "s1-t1",
                  name: "Read",
                  input: { file_path: "src/routes.ts" },
                },
              ],
            },
          })}\n`,
          "utf8",
        );
        writeFileSync(
          sub2Path,
          `${JSON.stringify({
            type: "assistant",
            uuid: "s2-a1",
            timestamp: "2026-11-13T21:00:01Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "s2-t1",
                  name: "Edit",
                  input: { file_path: "src/app.ts" },
                },
              ],
              usage: { input_tokens: 420, output_tokens: 80 },
            },
          })}\n`,
          "utf8",
        );

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_id: "sub-1",
            agent_type: "Codebase Researcher",
            agent_transcript_path: sub1Path,
            cwd: repoDir,
          }),
        });

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_id: "sub-2",
            agent_type: "Code Editor",
            agent_transcript_path: sub2Path,
            cwd: repoDir,
          }),
        });

        // Verify main SSE received agent_updated events
        const mainEvents = await readSseUntil(
          mainReader,
          (evs) =>
            evs.some((e) => e.type === "agent_updated" && e.agent?.agentId === "sub-1") &&
            evs.some((e) => e.type === "agent_updated" && e.agent?.agentId === "sub-2"),
        );
        expect(mainEvents.some((e) => e.type === "agent_updated" && e.agent?.agentId === "sub-1")).toBe(
          true,
        );
        expect(mainEvents.some((e) => e.type === "agent_updated" && e.agent?.agentId === "sub-2")).toBe(
          true,
        );

        // Verify GET /api/chat/sessions/:id/agents
        const agentsRes = await fetch(`${base}/api/chat/sessions/${sessionId}/agents`);
        expect(agentsRes.status).toBe(200);
        const agentsBody = (await agentsRes.json()) as { data: SessionAgentsResponse };
        expect(agentsBody.data.agents.map((a) => a.agentId)).toEqual(["main", "sub-1", "sub-2"]);

        const sub1 = agentsBody.data.agents.find((a) => a.agentId === "sub-1")!;
        expect(sub1.role).toBe("Codebase Researcher");
        expect(sub1.canSendInput).toBe(false);
        expect(sub1.state).toBe("reading");
        expect(sub1.currentTool).toBe("Read");
        expect(sub1.currentTarget).toBe("src/routes.ts");

        const sub2 = agentsBody.data.agents.find((a) => a.agentId === "sub-2")!;
        expect(sub2.state).toBe("editing");
        expect(sub2.usage?.inputTokens).toBe(420);

        // 3. Drill-down SSE stream for sub-1 (replay + live tail)
        const subCtrl = new AbortController();
        const subSse = await fetch(`${base}/api/chat/sessions/${sessionId}/agents/sub-1/events`, {
          signal: subCtrl.signal,
        });
        expect(subSse.status).toBe(200);
        const subReader = subSse.body!.getReader();

        appendFileSync(
          sub1Path,
          `${JSON.stringify({
            type: "assistant",
            uuid: "s1-a2",
            timestamp: "2026-11-13T21:00:05Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Found 3 routes in src/routes.ts." }],
            },
          })}\n`,
          "utf8",
        );

        const subEvents = await readSseUntil(
          subReader,
          (evs) =>
            evs.some((e) => e.type === "tool" && e.tool === "Thinking") &&
            evs.some((e) => e.type === "tool" && e.tool === "Read") &&
            evs.some((e) => e.type === "delta" && e.text?.includes("Found 3 routes")),
        );
        expect(subEvents.some((e) => e.type === "tool" && e.tool === "Thinking")).toBe(true);
        expect(subEvents.some((e) => e.type === "delta" && e.text?.includes("Found 3 routes"))).toBe(
          true,
        );
        subCtrl.abort();

        // 4. Shared Task List sync via disk ~/.claude/tasks/<sessionId>/ + hooks
        const sessionTaskDir = join(claudeHome, "tasks", sessionId);
        mkdirSync(sessionTaskDir, { recursive: true });
        writeFileSync(
          join(sessionTaskDir, "task-1.json"),
          JSON.stringify({
            id: "1",
            subject: "Audit routes",
            owner: "Codebase Researcher",
            status: "in_progress",
          }),
          "utf8",
        );

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "TaskCreated",
            task_id: "2",
            task_subject: "Write integration tests",
            task_status: "pending",
            teammate_name: "Code Editor",
          }),
        });

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "TaskCompleted",
            task_id: "2",
            task_subject: "Write integration tests",
          }),
        });

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "SubagentStop",
            agent_id: "sub-1",
          }),
        });

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "TeammateIdle",
            agent_id: "sub-2",
          }),
        });

        const afterRes = await fetch(`${base}/api/chat/sessions/${sessionId}/agents`);
        const afterBody = (await afterRes.json()) as { data: SessionAgentsResponse };

        const sub1Done = afterBody.data.agents.find((a) => a.agentId === "sub-1")!;
        expect(sub1Done.state).toBe("done");
        const sub2Idle = afterBody.data.agents.find((a) => a.agentId === "sub-2")!;
        expect(sub2Idle.state).toBe("idle");

        expect(afterBody.data.tasks.some((t) => t.id === "1" && t.status === "in_progress")).toBe(
          true,
        );
        expect(afterBody.data.tasks.some((t) => t.id === "2" && t.status === "completed")).toBe(
          true,
        );

        // Missing agent returns 404
        const missingAgent = await fetch(
          `${base}/api/chat/sessions/${sessionId}/agents/unknown-agent/events`,
        );
        expect(missingAgent.status).toBe(404);

        mainCtrl.abort();
      } finally {
        server.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates isolated git worktrees, separates per-worktree diffs, and safely merges/removes worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p4-wt-"));
    const repoDir = join(root, "repo");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/index.ts"), "export const base = 1;\n", "utf8");

    execGitSync(repoDir, ["init"]);
    execGitSync(repoDir, ["config", "user.email", "test@example.com"]);
    execGitSync(repoDir, ["config", "user.name", "Test"]);
    execGitSync(repoDir, ["add", "."]);
    execGitSync(repoDir, ["commit", "-m", "initial commit"]);

    try {
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p4-wt-token",
        },
        runner: makeStubRunner(),
        defaultCwd: repoDir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        // 1. Create 2 isolated worktrees
        const wt1Res = await fetch(`${base}/api/workspace/worktrees`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: repoDir, branch: "feat/alpha" }),
        });
        expect(wt1Res.status).toBe(200);
        const wt1 = ((await wt1Res.json()) as { data: CreateWorktreeResponse }).data.worktree;
        expect(wt1.branch).toBe("feat/alpha");
        expect(existsSync(wt1.path)).toBe(true);

        const wt2Res = await fetch(`${base}/api/workspace/worktrees`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: repoDir, branch: "feat/beta" }),
        });
        expect(wt2Res.status).toBe(200);
        const wt2 = ((await wt2Res.json()) as { data: CreateWorktreeResponse }).data.worktree;
        expect(wt2.branch).toBe("feat/beta");

        const listRes = await fetch(`${base}/api/workspace/worktrees?cwd=${encodeURIComponent(repoDir)}`);
        expect(listRes.status).toBe(200);
        const listBody = ((await listRes.json()) as { data: ListWorktreesResponse }).data;
        expect(listBody.worktrees.length).toBe(3);

        // 2. Start 2 sessions on the 2 separate worktrees
        const s1Res = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Work in alpha", cwd: wt1.path }),
        });
        const s1Id = ((await s1Res.json()) as { data: { session: { id: string } } }).data.session.id;

        const s2Res = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Work in beta", cwd: wt2.path }),
        });
        const s2Id = ((await s2Res.json()) as { data: { session: { id: string } } }).data.session.id;

        // 3. Edit files in each worktree independently (via hooks + git working tree)
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-wt-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Write",
            tool_use_id: "wt1-w",
            tool_input: { file_path: join(wt1.path, "src/alpha.ts") },
            cwd: wt1.path,
          }),
        });
        writeFileSync(join(wt1.path, "src/alpha.ts"), "export const alpha = true;\n", "utf8");
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-wt-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_use_id: "wt1-w",
            tool_input: { file_path: join(wt1.path, "src/alpha.ts") },
            cwd: wt1.path,
          }),
        });

        writeFileSync(join(wt2.path, "src/beta.ts"), "export const beta = true;\n", "utf8");

        // Verify changes are 100% isolated per worktree
        const c1Res = await fetch(`${base}/api/chat/sessions/${s1Id}/changes?mode=git`);
        const c1 = ((await c1Res.json()) as { data: SessionChangesResponse }).data;
        expect(c1.files.map((f) => f.path)).toEqual(["src/alpha.ts"]);

        const c2Res = await fetch(`${base}/api/chat/sessions/${s2Id}/changes?mode=git`);
        const c2 = ((await c2Res.json()) as { data: SessionChangesResponse }).data;
        expect(c2.files.map((f) => f.path)).toEqual(["src/beta.ts"]);

        // 4. Commit alpha in wt1 and merge + cleanup into main worktree
        execGitSync(wt1.path, ["add", "."]);
        execGitSync(wt1.path, ["commit", "-m", "add alpha"]);

        const mergeRes = await fetch(`${base}/api/workspace/worktrees/merge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: repoDir,
            worktreePath: wt1.path,
            removeAfterMerge: true,
          }),
        });
        expect(mergeRes.status).toBe(200);
        const mergeBody = ((await mergeRes.json()) as { data: MergeWorktreeResponse }).data;
        expect(mergeBody.merged).toBe(true);
        expect(mergeBody.worktreeRemoved).toBe(true);
        expect(existsSync(join(repoDir, "src/alpha.ts"))).toBe(true);
        expect(readFileSync(join(repoDir, "src/alpha.ts"), "utf8")).toContain("alpha = true");

        // 5. Force remove wt2 with uncommitted changes
        const rmRes = await fetch(`${base}/api/workspace/worktrees/remove`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: repoDir,
            worktreePath: wt2.path,
            force: true,
            deleteBranch: true,
          }),
        });
        expect(rmRes.status).toBe(200);
        const rmBody = ((await rmRes.json()) as { data: RemoveWorktreeResponse }).data;
        expect(rmBody.removed).toBe(true);

        const afterListRes = await fetch(
          `${base}/api/workspace/worktrees?cwd=${encodeURIComponent(repoDir)}`,
        );
        const afterList = ((await afterListRes.json()) as { data: ListWorktreesResponse }).data;
        expect(afterList.worktrees.length).toBe(1);
      } finally {
        server.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes agent-*.jsonl from discovery, forwards PermissionRequest/SubagentStop telemetry, tracks subagent transcript edits, and diffs sessionless worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p4-fixes-"));
    const repoDir = join(root, "repo");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(claudeHome, { recursive: true });

    execGitSync(repoDir, ["init"]);
    execGitSync(repoDir, ["config", "user.email", "test@example.com"]);
    execGitSync(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "src/index.ts"), "export const v = 1;\n", "utf8");
    execGitSync(repoDir, ["add", "."]);
    execGitSync(repoDir, ["commit", "-m", "init"]);

    const projectDir = join(claudeHome, "projects", "-tmp-repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "main-cli-123.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "main-cli-123",
        cwd: repoDir,
        message: { role: "user", content: "Inspect codebase" },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(projectDir, "agent-sub-999.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "agent-sub-999",
        cwd: repoDir,
        message: { role: "user", content: "Subagent internal prompt" },
      })}\n`,
      "utf8",
    );

    try {
      const { app, discovery } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p4-fix-token",
        },
        runner: makeStubRunner(),
        defaultCwd: repoDir,
      });

      await discovery.scanOnce();

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        // 1. agent-sub-999.jsonl must not be discovered as a top-level session
        const listRes = await fetch(`${base}/api/chat/sessions`);
        const sessionsList = ((await listRes.json()) as { data: { sessions: SessionInfo[] } }).data
          .sessions;
        expect(sessionsList.some((s) => s.externalSessionId === "main-cli-123")).toBe(true);
        expect(sessionsList.some((s) => s.externalSessionId === "agent-sub-999")).toBe(false);

        // 2. Create interactive session + start subagent writing via transcript (no Edit hooks)
        const sendRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Work on feature", model: "sonnet", cwd: repoDir }),
        });
        const sessionId = ((await sendRes.json()) as { data: { session: { id: string } } }).data
          .session.id;

        const subTranscript = join(root, "agent-child-1.jsonl");
        writeFileSync(join(repoDir, "src/child.ts"), "export const child = true;\n", "utf8");
        writeFileSync(
          subTranscript,
          [
            JSON.stringify({
              type: "assistant",
              uuid: "c1",
              timestamp: "2026-11-13T22:00:00Z",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "tu-child-write",
                    name: "Write",
                    input: { file_path: "src/child.ts", content: "export const child = true;\n" },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              uuid: "c2",
              timestamp: "2026-11-13T22:00:01Z",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "tu-child-write", content: "ok" }],
              },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-fix-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "SubagentStart",
            agent_id: "child-1",
            agent_type: "Implementer",
            agent_transcript_path: subTranscript,
            cwd: repoDir,
          }),
        });

        await new Promise((r) => setTimeout(r, 80));

        // GET /api/chat/agents returns child-1 under sessionId
        const allAgentsRes = await fetch(`${base}/api/chat/agents`);
        const allAgents = ((await allAgentsRes.json()) as { data: AllAgentsResponse }).data;
        expect(allAgents.bySession[sessionId]?.some((a) => a.agentId === "child-1")).toBe(true);

        // Session Changes attributed to child-1 from agent transcript
        const scRes = await fetch(`${base}/api/chat/sessions/${sessionId}/changes?mode=session`);
        const scBody = ((await scRes.json()) as { data: SessionChangesResponse }).data;
        const childChange = scBody.files.find((f) => f.path === "src/child.ts");
        expect(childChange?.contributors.some((c) => c.agentId === "child-1")).toBe(true);

        // 3. Subagent SSE receives live agent_updated when SubagentStop fires
        const subCtrl = new AbortController();
        const subSse = await fetch(`${base}/api/chat/sessions/${sessionId}/agents/child-1/events`, {
          signal: subCtrl.signal,
        });
        const subReader = subSse.body!.getReader();

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-fix-token",
            "x-claude-web-session-id": sessionId,
          },
          body: JSON.stringify({
            hook_event_name: "SubagentStop",
            agent_id: "child-1",
          }),
        });

        const subEvs = await readSseUntil(subReader, (evs) =>
          evs.some((e) => e.type === "agent_updated" && e.agent?.state === "done"),
        );
        expect(subEvs.some((e) => e.type === "agent_updated" && e.agent?.state === "done")).toBe(
          true,
        );
        subCtrl.abort();

        // 4. PermissionRequest (waitForDecision) sets agent waiting and resolves back to thinking
        const permPromise = fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p4-fix-token",
            "x-claude-web-session-id": sessionId,
            "x-harness-wait-decision": "1",
          },
          body: JSON.stringify({
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_input: { command: "bun test" },
            cwd: repoDir,
          }),
        });

        await new Promise((r) => setTimeout(r, 40));
        const midAgentsRes = await fetch(`${base}/api/chat/sessions/${sessionId}/agents`);
        const midAgents = ((await midAgentsRes.json()) as { data: SessionAgentsResponse }).data;
        expect(midAgents.agents.find((a) => a.agentId === "main")?.state).toBe("waiting");

        const sessionsListRes = await fetch(`${base}/api/chat/sessions`);
        const sessionsAfterPerm = (
          (await sessionsListRes.json()) as {
            data: { sessions: SessionInfo[] };
          }
        ).data.sessions;
        const detail = sessionsAfterPerm.find((s) => s.id === sessionId)!;
        await fetch(`${base}/api/chat/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            interactionId: detail.pendingInteraction?.id,
            inputType: "decision",
            value: "allow_once",
          }),
        });
        await permPromise;

        const afterPermRes = await fetch(`${base}/api/chat/sessions/${sessionId}/agents`);
        const afterPerm = ((await afterPermRes.json()) as { data: SessionAgentsResponse }).data;
        expect(afterPerm.agents.find((a) => a.agentId === "main")?.state).toBe("thinking");

        // 5. Sessionless workspace diff inspection on a fresh worktree
        const wtRes = await fetch(`${base}/api/workspace/worktrees`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: repoDir, branch: "feat/review-wt" }),
        });
        expect(wtRes.status).toBe(200);
        const wtPath = ((await wtRes.json()) as { data: CreateWorktreeResponse }).data.worktree.path;
        writeFileSync(join(wtPath, "src/index.ts"), "export const v = 2;\n", "utf8");

        const wsChangesRes = await fetch(
          `${base}/api/workspace/changes?cwd=${encodeURIComponent(wtPath)}`,
        );
        expect(wsChangesRes.status).toBe(200);
        const wsChanges = ((await wsChangesRes.json()) as { data: SessionChangesResponse }).data;
        expect(wsChanges.files.map((f) => f.path)).toEqual(["src/index.ts"]);

        const wsDiffRes = await fetch(
          `${base}/api/workspace/changes/diff?cwd=${encodeURIComponent(wtPath)}&path=${encodeURIComponent("src/index.ts")}`,
        );
        expect(wsDiffRes.status).toBe(200);
        const wsDiff = ((await wsDiffRes.json()) as { data: FileDiffResponse }).data;
        expect(wsDiff.unifiedDiff).toContain("+export const v = 2;");
      } finally {
        server.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
