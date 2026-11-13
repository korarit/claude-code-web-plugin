import { describe, expect, test } from "bun:test";
import { TmuxNotAvailableError } from "../src/modules/chat/domain/errors.ts";
import {
  buildClaudeInteractiveCommand,
  buildNewSessionArgs,
  TmuxRunner,
  tmuxSessionName,
  type ExecCommandFn,
} from "../src/modules/chat/infrastructure/tmux-runner.ts";

describe("tmux-runner", () => {
  test("builds deterministic tmux session names and quoted claude commands", () => {
    expect(tmuxSessionName("550e8400-e29b-41d4-a716-446655440000")).toBe("cw-550e8400-e29");

    const cmd = buildClaudeInteractiveCommand({
      sessionId: "abc-123",
      model: "opus",
    });
    expect(cmd).toBe("'claude' '--session-id' 'abc-123' '--model' 'opus'");

    const resumeCmd = buildClaudeInteractiveCommand({
      sessionId: "abc-123",
      model: "sonnet",
      resumeSessionId: "ext-999",
    });
    expect(resumeCmd).toBe("'claude' '--resume' 'ext-999' '--model' 'sonnet'");

    const args = buildNewSessionArgs("cw-abc123", {
      sessionId: "abc-123",
      model: "sonnet",
      cwd: "/tmp/my 'project'",
      port: 3100,
      token: "tok-1",
    });
    expect(args).toEqual([
      "new-session",
      "-d",
      "-s",
      "cw-abc123",
      "-c",
      "/tmp/my 'project'",
      "-e",
      "CLAUDE_WEB_SESSION_ID=abc-123",
      "-e",
      "CLAUDE_WEB_PORT=3100",
      "-e",
      "CLAUDE_WEB_TOKEN=tok-1",
      "'claude' '--session-id' 'abc-123' '--model' 'sonnet'",
    ]);
  });

  test("throws TmuxNotAvailableError when tmux is missing", async () => {
    const runner = new TmuxRunner({
      exec: async () => ({ exitCode: 127, stdout: "", stderr: "tmux: not found" }),
    });
    expect(await runner.isAvailable()).toBe(false);
    await expect(
      runner.ensureSession({
        sessionId: "s-1",
        model: "sonnet",
        cwd: "/tmp",
        port: 3000,
        token: "t",
      }),
    ).rejects.toBeInstanceOf(TmuxNotAvailableError);
  });

  test("sendPrompt streams multiline & special chars via load-buffer stdin + paste-buffer + Enter", async () => {
    const calls: Array<{ cmd: string[]; stdin?: string }> = [];
    const exec: ExecCommandFn = async (cmd, opts) => {
      calls.push({ cmd, stdin: opts?.stdin });
      if (cmd[1] === "-V") return { exitCode: 0, stdout: "tmux 3.4", stderr: "" };
      if (cmd[1] === "has-session") return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd[1] === "capture-pane") return { exitCode: 0, stdout: "Claude Code\n❯ ", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const runner = new TmuxRunner({ exec, bootTimeoutMs: 500, pollIntervalMs: 10 });
    const ensured = await runner.ensureSession({
      sessionId: "sess-1",
      model: "sonnet",
      cwd: "/tmp",
      port: 3000,
      token: "secret",
    });
    expect(ensured).toEqual({ tmuxSession: "cw-sess-1", isNew: true });

    const multilinePrompt = 'Line 1 with "quotes" & $vars\nLine 2 with `backticks` and \'single\'';
    await runner.sendPrompt(ensured.tmuxSession, multilinePrompt);

    const loadCall = calls.find((c) => c.cmd[1] === "load-buffer");
    expect(loadCall?.stdin).toBe(multilinePrompt);
    expect(calls.some((c) => c.cmd[1] === "paste-buffer" && c.cmd.includes("cw-sess-1"))).toBe(true);
    expect(calls.some((c) => c.cmd[1] === "send-keys" && c.cmd.includes("Enter"))).toBe(true);

    await runner.abortSession(ensured.tmuxSession);
    expect(calls.some((c) => c.cmd[1] === "send-keys" && c.cmd.includes("C-c"))).toBe(true);

    await runner.stopSession(ensured.tmuxSession);
    expect(calls.some((c) => c.cmd[1] === "kill-session" && c.cmd.includes("cw-sess-1"))).toBe(true);
  });
});
