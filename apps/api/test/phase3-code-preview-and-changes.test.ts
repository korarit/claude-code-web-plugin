import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatStreamEvent, FileDiffResponse, RawFileResponse, SessionChangesResponse } from "@contracts/index";
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

function execGitSync(cwd: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(res.stderr)}`);
  }
}

describe("Phase 3: Session Code Preview, File Changes & Diff Viewer", () => {
  test("tracks PreToolUse/PostToolUse edits, emits file_changed SSE, separates revisions across model switches, and isolates 2 sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p3-"));
    const repoDir = join(root, "repo");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/app.ts"), "export const v = 1;\n");
    writeFileSync(join(repoDir, "src/other.ts"), "export const other = 'a';\n");

    try {
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p3-token",
        },
        runner: makeStubRunner(),
        defaultCwd: repoDir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        // Create 2 sessions in the same repo
        const s1Res = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Edit app.ts", model: "sonnet", cwd: repoDir }),
        });
        const s1Id = ((await s1Res.json()) as { data: { session: { id: string } } }).data.session.id;

        const s2Res = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Edit other.ts", model: "haiku", cwd: repoDir }),
        });
        const s2Id = ((await s2Res.json()) as { data: { session: { id: string } } }).data.session.id;

        // Subscribe to Session 1 SSE stream
        const sseCtrl = new AbortController();
        const sseRes = await fetch(`${base}/api/chat/sessions/${s1Id}/events`, {
          signal: sseCtrl.signal,
        });
        expect(sseRes.status).toBe(200);
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();

        // Revision 1 on Session 1 (sonnet) via PreToolUse -> file edit -> PostToolUse
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-1",
            tool_input: { file_path: join(repoDir, "src/app.ts") },
            cwd: repoDir,
          }),
        });

        writeFileSync(join(repoDir, "src/app.ts"), "export const v = 2;\nexport const two = true;\n");

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-1",
            tool_input: { file_path: join(repoDir, "src/app.ts") },
            cwd: repoDir,
          }),
        });

        // Verify SSE receives file_changed event
        let sseBuffer = "";
        let sawFileChanged = false;
        for (let i = 0; i < 15; i++) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<{ done: boolean; value?: Uint8Array }>((r) =>
              setTimeout(() => r({ done: false }), 100),
            ),
          ]);
          if (chunk.value) {
            sseBuffer += decoder.decode(chunk.value, { stream: true });
            if (sseBuffer.includes("event: file_changed")) {
              sawFileChanged = true;
              break;
            }
          }
        }
        sseCtrl.abort();
        expect(sawFileChanged).toBe(true);
        expect(sseBuffer).toContain("src/app.ts");

        // Switch Session 1 to opus via /model opus and perform Revision 2 on same file
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({ hook_event_name: "Stop" }),
        });
        await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: s1Id, prompt: "/model opus" }),
        });

        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-2",
            tool_input: { file_path: "src/app.ts" },
            cwd: repoDir,
          }),
        });
        writeFileSync(
          join(repoDir, "src/app.ts"),
          "export const v = 2;\nexport const two = true;\nexport const opusLine = 3;\n",
        );
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-2",
            tool_input: { file_path: "src/app.ts" },
            cwd: repoDir,
          }),
        });

        // Also create a new file in Session 1 via Write
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Write",
            tool_use_id: "tu-3",
            tool_input: { file_path: "src/new-util.ts" },
            cwd: repoDir,
          }),
        });
        writeFileSync(join(repoDir, "src/new-util.ts"), "export const util = () => 42;\n");
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s1Id,
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_use_id: "tu-3",
            tool_input: { file_path: "src/new-util.ts" },
            cwd: repoDir,
          }),
        });

        // Session 2 edits src/other.ts only
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s2Id,
          },
          body: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-s2-1",
            tool_input: { file_path: "src/other.ts" },
            cwd: repoDir,
          }),
        });
        writeFileSync(join(repoDir, "src/other.ts"), "export const other = 'b';\n");
        await fetch(`${base}/api/chat/hooks`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-harness-token": "p3-token",
            "x-claude-web-session-id": s2Id,
          },
          body: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "Edit",
            tool_use_id: "tu-s2-1",
            tool_input: { file_path: "src/other.ts" },
            cwd: repoDir,
          }),
        });

        // Check Session 1 changes (isolated from Session 2)
        const s1ChangesRes = await fetch(`${base}/api/chat/sessions/${s1Id}/changes`);
        expect(s1ChangesRes.status).toBe(200);
        const s1Changes = ((await s1ChangesRes.json()) as { data: SessionChangesResponse }).data;
        expect(s1Changes.files.map((f) => f.path).sort()).toEqual(["src/app.ts", "src/new-util.ts"]);

        const appChange = s1Changes.files.find((f) => f.path === "src/app.ts")!;
        expect(appChange.revisions).toHaveLength(2);
        expect(appChange.revisions[0]!.model).toBe("sonnet");
        expect(appChange.revisions[1]!.model).toBe("opus");
        expect(appChange.contributors.map((c) => c.model)).toEqual(["sonnet", "opus"]);

        // Check Session 2 changes (isolated from Session 1)
        const s2ChangesRes = await fetch(`${base}/api/chat/sessions/${s2Id}/changes`);
        const s2Changes = ((await s2ChangesRes.json()) as { data: SessionChangesResponse }).data;
        expect(s2Changes.files.map((f) => f.path)).toEqual(["src/other.ts"]);

        // Per-revision diff (revId of opus edit) vs cumulative diff
        const opusRevId = appChange.revisions[1]!.revId;
        const revDiffRes = await fetch(
          `${base}/api/chat/sessions/${s1Id}/changes/diff?path=src/app.ts&revId=${encodeURIComponent(opusRevId)}`,
        );
        expect(revDiffRes.status).toBe(200);
        const revDiff = ((await revDiffRes.json()) as { data: FileDiffResponse }).data;
        expect(revDiff.editedBy?.model).toBe("opus");
        expect(revDiff.originalText).toContain("export const v = 2;");
        expect(revDiff.modifiedText).toContain("export const opusLine = 3;");
        expect(revDiff.unifiedDiff).toContain("+export const opusLine = 3;");
        expect(revDiff.unifiedDiff).not.toContain("-export const v = 1;");

        const cumDiffRes = await fetch(
          `${base}/api/chat/sessions/${s1Id}/changes/diff?path=src/app.ts`,
        );
        const cumDiff = ((await cumDiffRes.json()) as { data: FileDiffResponse }).data;
        expect(cumDiff.originalText).toBe("export const v = 1;\n");
        expect(cumDiff.unifiedDiff).toContain("-export const v = 1;");

        // Raw file preview
        const rawRes = await fetch(
          `${base}/api/chat/sessions/${s1Id}/files/raw?path=src/app.ts`,
        );
        expect(rawRes.status).toBe(200);
        const raw = ((await rawRes.json()) as { data: RawFileResponse }).data;
        expect(raw.content).toContain("opusLine = 3");
        expect(raw.isBinary).toBe(false);

        // Revert newly added file in session mode -> deletes file
        const revertNew = await fetch(`${base}/api/chat/sessions/${s1Id}/changes/revert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "src/new-util.ts", mode: "session" }),
        });
        expect(revertNew.status).toBe(200);
        expect(existsSync(join(repoDir, "src/new-util.ts"))).toBe(false);

        // Revert modified file in session mode -> restores baseline
        const revertMod = await fetch(`${base}/api/chat/sessions/${s1Id}/changes/revert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "src/app.ts", mode: "session" }),
        });
        expect(revertMod.status).toBe(200);
        expect(readFileSync(join(repoDir, "src/app.ts"), "utf8")).toBe("export const v = 1;\n");
      } finally {
        await server.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal & symlink escape (403) and tracks Bash edits in All Git Changes mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p3-git-"));
    const repoDir = join(root, "git-repo");
    const outsideFile = join(root, "secret.txt");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(outsideFile, "TOP_SECRET");
    writeFileSync(join(repoDir, "README.md"), "# Demo\n");

    execGitSync(repoDir, ["init"]);
    execGitSync(repoDir, ["config", "user.email", "test@example.com"]);
    execGitSync(repoDir, ["config", "user.name", "Test"]);
    execGitSync(repoDir, ["add", "."]);
    execGitSync(repoDir, ["commit", "-m", "init"]);

    // Create symlink inside repo pointing outside workspace
    symlinkSync(outsideFile, join(repoDir, "escape-link.txt"));

    try {
      const { app } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p3-git-tok",
        },
        runner: makeStubRunner(),
        defaultCwd: repoDir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        const sRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Check git", cwd: repoDir }),
        });
        const sid = ((await sRes.json()) as { data: { session: { id: string } } }).data.session.id;

        // Security: reject ../ traversal and symlink escape
        const travRaw = await fetch(
          `${base}/api/chat/sessions/${sid}/files/raw?path=${encodeURIComponent("../secret.txt")}`,
        );
        expect(travRaw.status).toBe(403);

        const travDiff = await fetch(
          `${base}/api/chat/sessions/${sid}/changes/diff?path=${encodeURIComponent("../secret.txt")}&mode=git`,
        );
        expect(travDiff.status).toBe(403);

        const symlinkRaw = await fetch(
          `${base}/api/chat/sessions/${sid}/files/raw?path=escape-link.txt`,
        );
        expect(symlinkRaw.status).toBe(403);

        // Simulate indirect Bash edits (modifying README.md and creating bash-out.txt)
        writeFileSync(join(repoDir, "README.md"), "# Demo\nUpdated via bash\n");
        writeFileSync(join(repoDir, "bash-out.txt"), "hello\nworld\n");

        const gitChangesRes = await fetch(`${base}/api/chat/sessions/${sid}/changes?mode=git`);
        expect(gitChangesRes.status).toBe(200);
        const gitChanges = ((await gitChangesRes.json()) as { data: SessionChangesResponse }).data;
        const paths = gitChanges.files.map((f) => f.path);
        expect(paths).toContain("README.md");
        expect(paths).toContain("bash-out.txt");

        const gitDiffRes = await fetch(
          `${base}/api/chat/sessions/${sid}/changes/diff?path=README.md&mode=git`,
        );
        expect(gitDiffRes.status).toBe(200);
        const gitDiff = ((await gitDiffRes.json()) as { data: FileDiffResponse }).data;
        expect(gitDiff.unifiedDiff).toContain("+Updated via bash");

        // Revert in git mode
        const revertRes = await fetch(`${base}/api/chat/sessions/${sid}/changes/revert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "README.md", mode: "git" }),
        });
        expect(revertRes.status).toBe(200);
        expect(readFileSync(join(repoDir, "README.md"), "utf8")).toBe("# Demo\n");
      } finally {
        await server.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles git subdirectory cwd, staged file revert, and subagent agentId enrichment", async () => {
    const root = mkdtempSync(join(tmpdir(), "hw-p3-sub-"));
    const repoDir = join(root, "monorepo");
    const subDir = join(repoDir, "packages", "sub");
    const claudeHome = join(root, ".claude");
    const harnessHome = join(root, ".harness-web");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "index.ts"), "export const x = 1;\n");

    execGitSync(repoDir, ["init"]);
    execGitSync(repoDir, ["config", "user.email", "test@example.com"]);
    execGitSync(repoDir, ["config", "user.name", "Test"]);
    execGitSync(repoDir, ["add", "."]);
    execGitSync(repoDir, ["commit", "-m", "init"]);

    try {
      const { app, fileChangeTracker } = createApp({
        env: {
          host: "127.0.0.1",
          port: 0,
          harnessHome,
          claudeHome,
          token: "p3-sub-tok",
        },
        runner: makeStubRunner(),
        defaultCwd: subDir,
      });

      const server = app.listen({ hostname: "127.0.0.1", port: 0 });
      const port = server.server?.port ?? 0;
      const base = `http://127.0.0.1:${port}`;

      try {
        const sRes = await fetch(`${base}/api/chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Subdir test", cwd: subDir }),
        });
        const sid = ((await sRes.json()) as { data: { session: { id: string } } }).data.session.id;

        // Edit in subdir + stage a new file in subdir
        writeFileSync(join(subDir, "index.ts"), "export const x = 2;\n");
        writeFileSync(join(subDir, "staged.ts"), "export const staged = true;\n");
        execGitSync(repoDir, ["add", "packages/sub/staged.ts"]);

        const gitChangesRes = await fetch(`${base}/api/chat/sessions/${sid}/changes?mode=git`);
        const gitChanges = ((await gitChangesRes.json()) as { data: SessionChangesResponse }).data;
        expect(gitChanges.files.map((f) => f.path).sort()).toEqual(["index.ts", "staged.ts"]);

        const subDiffRes = await fetch(
          `${base}/api/chat/sessions/${sid}/changes/diff?path=index.ts&mode=git`,
        );
        expect(subDiffRes.status).toBe(200);
        const subDiff = ((await subDiffRes.json()) as { data: FileDiffResponse }).data;
        expect(subDiff.unifiedDiff).toContain("+export const x = 2;");

        // Revert staged new file in git mode -> unstages and removes file
        const revertStaged = await fetch(`${base}/api/chat/sessions/${sid}/changes/revert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "staged.ts", mode: "git" }),
        });
        expect(revertStaged.status).toBe(200);
        expect(existsSync(join(subDir, "staged.ts"))).toBe(false);

        // Subagent toolUseId enrichment: PostToolUse hook arrives without agentId, then JSONL enriches agentId
        await fileChangeTracker.onPreToolUse({
          sessionId: sid,
          cwd: subDir,
          harnessId: "claude",
          model: "sonnet",
          toolName: "Edit",
          toolUseId: "tu-sub-1",
          toolInput: { file_path: "index.ts" },
        });
        writeFileSync(join(subDir, "index.ts"), "export const x = 3;\n");
        await fileChangeTracker.onPostToolUse({
          sessionId: sid,
          cwd: subDir,
          harnessId: "claude",
          model: "sonnet",
          toolName: "Edit",
          toolUseId: "tu-sub-1",
          toolInput: { file_path: "index.ts" },
        });
        await fileChangeTracker.onPostToolUse({
          sessionId: sid,
          cwd: subDir,
          harnessId: "claude",
          model: "claude-sonnet-4-5",
          toolName: "Edit",
          toolUseId: "tu-sub-1",
          toolInput: { file_path: "index.ts" },
          agentId: "agent-task-77",
        });

        const sessChangesRes = await fetch(`${base}/api/chat/sessions/${sid}/changes`);
        const sessChanges = ((await sessChangesRes.json()) as { data: SessionChangesResponse }).data;
        const idxFile = sessChanges.files.find((f) => f.path === "index.ts")!;
        expect(idxFile.revisions).toHaveLength(1);
        expect(idxFile.lastEditedBy.agentId).toBe("agent-task-77");
      } finally {
        await server.stop(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
