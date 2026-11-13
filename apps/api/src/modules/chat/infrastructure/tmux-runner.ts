import { ClaudeSpawnError, TmuxNotAvailableError } from "../domain/errors.ts";
import type {
  ActiveTerminalSession,
  EnsureSessionOptions,
  EnsureSessionResult,
  TerminalRunnerPort,
} from "../application/ports.ts";

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecCommandFn = (
  cmd: string[],
  options?: { stdin?: string; cwd?: string },
) => Promise<ExecCommandResult>;

async function defaultExec(
  cmd: string[],
  options?: { stdin?: string; cwd?: string },
): Promise<ExecCommandResult> {
  const proc = Bun.spawn(cmd, {
    stdin: options?.stdin !== undefined ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function tmuxSessionName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
  return `cw-${cleaned || "session"}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildClaudeInteractiveCommand(
  options: Pick<EnsureSessionOptions, "sessionId" | "model" | "resumeSessionId">,
  claudeBin = "claude",
): string {
  const args: string[] = [claudeBin];
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else {
    args.push("--session-id", options.sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  return args.map(shellQuote).join(" ");
}

export function buildNewSessionArgs(
  tmuxSession: string,
  options: EnsureSessionOptions,
  claudeBin = "claude",
): string[] {
  const command = buildClaudeInteractiveCommand(options, claudeBin);
  return [
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "-c",
    options.cwd,
    "-e",
    `CLAUDE_WEB_SESSION_ID=${options.sessionId}`,
    "-e",
    `CLAUDE_WEB_PORT=${options.port}`,
    "-e",
    `CLAUDE_WEB_TOKEN=${options.token}`,
    command,
  ];
}

export interface TmuxRunnerConfig {
  tmuxBin?: string;
  claudeBin?: string;
  exec?: ExecCommandFn;
  bootTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class TmuxRunner implements TerminalRunnerPort {
  private readonly tmuxBin: string;
  private readonly claudeBin: string;
  private readonly exec: ExecCommandFn;
  private readonly bootTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly readyWaiters = new Map<string, () => void>();

  constructor(config: TmuxRunnerConfig = {}) {
    this.tmuxBin = config.tmuxBin ?? "tmux";
    this.claudeBin = config.claudeBin ?? "claude";
    this.exec = config.exec ?? defaultExec;
    this.bootTimeoutMs = config.bootTimeoutMs ?? 4_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 150;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.exec([this.tmuxBin, "-V"]);
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  notifyReady(sessionId: string): void {
    const resolve = this.readyWaiters.get(sessionId);
    if (resolve) {
      this.readyWaiters.delete(sessionId);
      resolve();
    }
  }

  async ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult> {
    if (!(await this.isAvailable())) {
      throw new TmuxNotAvailableError();
    }

    const tmuxSession = tmuxSessionName(options.sessionId);
    const has = await this.exec([this.tmuxBin, "has-session", "-t", tmuxSession]);
    if (has.exitCode === 0) {
      return { tmuxSession, isNew: false };
    }

    const args = buildNewSessionArgs(tmuxSession, options, this.claudeBin);
    const created = await this.exec([this.tmuxBin, ...args]);
    if (created.exitCode !== 0) {
      throw new ClaudeSpawnError(
        created.stderr.trim() || `tmux new-session failed with exit code ${created.exitCode}`,
      );
    }

    await this.waitUntilReady(options.sessionId, tmuxSession);
    return { tmuxSession, isNew: true };
  }

  async sendPrompt(tmuxSession: string, prompt: string): Promise<void> {
    const bufName = `cw-buf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const loadRes = await this.exec([this.tmuxBin, "load-buffer", "-b", bufName, "-"], {
      stdin: prompt,
    });
    if (loadRes.exitCode !== 0) {
      throw new ClaudeSpawnError(
        loadRes.stderr.trim() || `tmux load-buffer failed with exit code ${loadRes.exitCode}`,
      );
    }

    const pasteRes = await this.exec([
      this.tmuxBin,
      "paste-buffer",
      "-b",
      bufName,
      "-t",
      tmuxSession,
    ]);
    await this.exec([this.tmuxBin, "delete-buffer", "-b", bufName]).catch(() => {});

    if (pasteRes.exitCode !== 0) {
      throw new ClaudeSpawnError(
        pasteRes.stderr.trim() || `tmux paste-buffer failed with exit code ${pasteRes.exitCode}`,
      );
    }

    const enterRes = await this.exec([this.tmuxBin, "send-keys", "-t", tmuxSession, "Enter"]);
    if (enterRes.exitCode !== 0) {
      throw new ClaudeSpawnError(
        enterRes.stderr.trim() || `tmux send-keys Enter failed with exit code ${enterRes.exitCode}`,
      );
    }
  }

  async sendRawKeys(tmuxSession: string, keys: string): Promise<void> {
    const res = await this.exec([this.tmuxBin, "send-keys", "-t", tmuxSession, keys]);
    if (res.exitCode !== 0) {
      throw new ClaudeSpawnError(
        res.stderr.trim() || `tmux send-keys failed with exit code ${res.exitCode}`,
      );
    }
  }

  async abortSession(tmuxSession: string): Promise<void> {
    await this.exec([this.tmuxBin, "send-keys", "-t", tmuxSession, "C-c"]);
  }

  async stopSession(tmuxSession: string): Promise<void> {
    await this.exec([this.tmuxBin, "kill-session", "-t", tmuxSession]);
  }

  async listActiveSessions(): Promise<ActiveTerminalSession[]> {
    const res = await this.exec([
      this.tmuxBin,
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_path}",
    ]);
    if (res.exitCode !== 0) return [];

    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, cwd] = line.split("\t");
        return { name: name ?? "", cwd: cwd || undefined };
      })
      .filter((item) => item.name.length > 0);
  }

  private async waitUntilReady(sessionId: string, tmuxSession: string): Promise<void> {
    if (this.bootTimeoutMs <= 0) return;

    let hookFired = false;
    const hookPromise = new Promise<void>((resolve) => {
      this.readyWaiters.set(sessionId, () => {
        hookFired = true;
        resolve();
      });
    });

    const deadline = Date.now() + this.bootTimeoutMs;
    while (!hookFired && Date.now() < deadline) {
      const pane = await this.exec([this.tmuxBin, "capture-pane", "-p", "-t", tmuxSession]);
      if (pane.exitCode === 0 && /[❯>]\s*$/.test(pane.stdout.trimEnd())) {
        break;
      }
      await Promise.race([
        hookPromise,
        new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs)),
      ]);
    }
    this.readyWaiters.delete(sessionId);
  }
}
