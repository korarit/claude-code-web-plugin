import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DiscoveredExternalSession, HarnessCapabilities } from "@contracts/harness";
import type {
  HarnessAdapter,
  HarnessInputPayload,
  HarnessSendInputResult,
  HarnessSessionContext,
  NormalizedHarnessEvent,
  StartedHarnessSession,
  StartHarnessSessionOptions,
} from "../domain/harness.port.ts";
import { HarnessSpawnError } from "../domain/errors.ts";
import {
  defaultExec,
  resolveBinaryPath,
  shellQuote,
  type ExecCommandFn,
} from "./binary-probe.ts";
import {
  buildTuiQuestionKeystrokes,
  listTmuxPanes,
  pasteBufferToTmux,
} from "./tmux-helpers.ts";
import {
  createAgyParseState,
  inspectAgyTranscript,
  parseAgyTranscriptLine,
  type AgyParseState,
} from "./agy-transcript.parser.ts";

const DEFAULT_AGY_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-4-5",
  "claude-opus-4-1",
];

interface AgyWatchState {
  sessionId: string;
  transcriptPath: string;
  byteOffset: number;
  remainder: string;
  parseState: AgyParseState;
  onEvent: (event: NormalizedHarnessEvent) => void;
  fsWatcher?: FSWatcher;
  dirWatcher?: FSWatcher;
  pollTimer?: ReturnType<typeof setInterval>;
  discoveryTimer?: ReturnType<typeof setInterval>;
  reading: boolean;
}

export interface AntigravityHarnessAdapterConfig {
  agyCliHome: string;
  agyIdeHome?: string;
  enableIdeDiscovery?: boolean;
  agyBin?: string;
  tmuxBin?: string;
  exec?: ExecCommandFn;
  bootTimeoutMs?: number;
  pollIntervalMs?: number;
}

export function buildAgyTmuxCommand(
  options: Pick<StartHarnessSessionOptions, "model" | "resumeSessionId" | "agentProfile">,
  agyBin = "agy",
): string {
  const args = [agyBin];
  if (options.resumeSessionId) {
    args.push("--conversation", options.resumeSessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.agentProfile) {
    args.push("--agent", options.agentProfile);
  }
  return args.map(shellQuote).join(" ");
}

export class AntigravityHarnessAdapter implements HarnessAdapter {
  readonly id = "agy" as const;
  readonly name = "Antigravity CLI";
  readonly binary: string;
  readonly capabilities: HarnessCapabilities = {
    hooks: true,
    jsonlTranscript: true,
    serverApi: false,
    resume: true,
    subagents: true,
    externalDiscovery: true,
  };

  private readonly tmuxBin: string;
  private readonly exec: ExecCommandFn;
  private readonly bootTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchers = new Map<string, AgyWatchState>();
  private readonly sessionStartTimes = new Map<string, number>();

  constructor(private readonly config: AntigravityHarnessAdapterConfig) {
    this.binary = config.agyBin ?? "agy";
    this.tmuxBin = config.tmuxBin ?? "tmux";
    this.exec = config.exec ?? defaultExec;
    this.bootTimeoutMs = config.bootTimeoutMs ?? 4_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 200;
  }

  getDefaultModel(): string {
    return DEFAULT_AGY_MODELS[0]!;
  }

  private async resolveAgyBin(): Promise<string> {
    const home = homedir();
    const resolved = await resolveBinaryPath(
      this.binary,
      [join(home, ".gemini", "bin", "agy"), join(home, ".local", "bin", "agy")],
      this.exec,
    );
    return resolved ?? this.binary;
  }

  async detectAvailability(): Promise<boolean> {
    const home = homedir();
    const resolved = await resolveBinaryPath(
      this.binary,
      [join(home, ".gemini", "bin", "agy"), join(home, ".local", "bin", "agy")],
      this.exec,
    );
    return resolved !== null;
  }

  async listModels(): Promise<string[]> {
    const bin = await this.resolveAgyBin();
    const res = await this.exec([bin, "models"]).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    }));
    if (res.exitCode === 0 && res.stdout.trim()) {
      const parsed = res.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((token) => /^[a-z0-9][a-z0-9._-]+$/i.test(token) && !token.startsWith("-"));
      if (parsed.length > 0) {
        return [...new Set(parsed)];
      }
    }
    return [...DEFAULT_AGY_MODELS];
  }

  async listAgentProfiles(): Promise<string[]> {
    const dirs = [join(this.config.agyCliHome, "agents")];
    if (this.config.agyIdeHome) {
      dirs.push(join(this.config.agyIdeHome, "agents"));
    }
    const profiles = new Set<string>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            profiles.add(entry.name.replace(/\.md$/, ""));
          }
        }
      } catch {
        // Ignore unreadable agents directory.
      }
    }
    return [...profiles].sort();
  }

  resolveTranscriptPath(_cwd: string, conversationId: string): string {
    return join(
      this.config.agyCliHome,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
  }

  async startOrResumeSession(options: StartHarnessSessionOptions): Promise<StartedHarnessSession> {
    const tmuxCheck = await this.exec([this.tmuxBin, "-V"]).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    }));
    if (tmuxCheck.exitCode !== 0) {
      throw new HarnessSpawnError("agy", "tmux is required to run Antigravity CLI interactively");
    }

    const cleaned = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
    const tmuxSession = options.tmuxSessionName || `cw-${cleaned || "agy"}`;

    const has = await this.exec([this.tmuxBin, "has-session", "-t", tmuxSession]);
    if (has.exitCode === 0) {
      return {
        harnessId: "agy",
        tmuxSession,
        externalSessionId: options.resumeSessionId,
        transcriptPath: options.resumeSessionId
          ? this.resolveTranscriptPath(options.cwd, options.resumeSessionId)
          : undefined,
        isNew: false,
      };
    }

    const bin = await this.resolveAgyBin();
    const command = buildAgyTmuxCommand(options, bin);
    this.sessionStartTimes.set(options.sessionId, Date.now() - 1000);

    const created = await this.exec([
      this.tmuxBin,
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-c",
      options.cwd,
      "-e",
      `CLAUDE_WEB_SESSION_ID=${options.sessionId}`,
      "-e",
      `AGY_WEB_SESSION_ID=${options.sessionId}`,
      "-e",
      `HARNESS_WAIT_PRETOOLUSE=1`,
      "-e",
      `CLAUDE_WEB_PORT=${options.port}`,
      "-e",
      `CLAUDE_WEB_TOKEN=${options.token}`,
      command,
    ]);
    if (created.exitCode !== 0) {
      throw new HarnessSpawnError(
        "agy",
        created.stderr.trim() || `tmux new-session failed (${created.exitCode})`,
      );
    }

    await this.waitUntilReady(tmuxSession);
    return {
      harnessId: "agy",
      tmuxSession,
      externalSessionId: options.resumeSessionId,
      transcriptPath: options.resumeSessionId
        ? this.resolveTranscriptPath(options.cwd, options.resumeSessionId)
        : undefined,
      isNew: true,
    };
  }

  async sendPrompt(session: HarnessSessionContext, prompt: string): Promise<void> {
    if (!session.tmuxSession) {
      throw new HarnessSpawnError("agy", "missing tmuxSession");
    }
    await pasteBufferToTmux("agy", this.exec, session.tmuxSession, prompt, this.tmuxBin);
  }

  async sendInput(payload: HarnessInputPayload): Promise<HarnessSendInputResult> {
    if (!payload.tmuxSession) {
      return { handled: false, method: "tmux", resolved: false };
    }

    if (payload.inputType === "decision") {
      const decision = String(payload.value);
      const fallbackKey =
        decision === "allow_once" ? "1" : decision === "always_allow" ? "2" : "3";
      await this.exec([this.tmuxBin, "send-keys", "-t", payload.tmuxSession, fallbackKey]);
      return { handled: true, method: "tmux", resolved: true };
    }

    if (payload.inputType === "selection") {
      const pending = payload.pendingInteraction;
      if (pending && pending.kind === "question") {
        await this.exec([this.tmuxBin, "capture-pane", "-p", "-S", "-40", "-t", payload.tmuxSession]);
        const steps = buildTuiQuestionKeystrokes(pending.questions, payload.value);
        for (const step of steps) {
          if (step.keys) {
            for (const key of step.keys) {
              await this.exec([this.tmuxBin, "send-keys", "-t", payload.tmuxSession, key]);
            }
          }
          if (step.text) {
            await pasteBufferToTmux("agy", this.exec, payload.tmuxSession, step.text, this.tmuxBin);
          }
        }
        return { handled: true, method: "tmux", resolved: false };
      }
      const fallback = Array.isArray(payload.value)
        ? payload.value.join(", ")
        : typeof payload.value === "string"
          ? payload.value
          : JSON.stringify(payload.value);
      await pasteBufferToTmux("agy", this.exec, payload.tmuxSession, fallback, this.tmuxBin);
      return { handled: true, method: "tmux", resolved: false };
    }

    if (payload.inputType === "key") {
      await this.exec([
        this.tmuxBin,
        "send-keys",
        "-t",
        payload.tmuxSession,
        String(payload.value).trim(),
      ]);
      return { handled: true, method: "tmux", resolved: false };
    }

    if (payload.inputType === "text") {
      await pasteBufferToTmux(
        "agy",
        this.exec,
        payload.tmuxSession,
        String(payload.value ?? ""),
        this.tmuxBin,
      );
      return { handled: true, method: "tmux", resolved: false };
    }

    return { handled: false, method: "tmux", resolved: false };
  }

  async abortSession(session: HarnessSessionContext): Promise<void> {
    if (session.tmuxSession) {
      await this.exec([this.tmuxBin, "send-keys", "-t", session.tmuxSession, "C-c"]);
    }
  }

  async stopSession(session: HarnessSessionContext): Promise<void> {
    if (session.tmuxSession) {
      await this.exec([this.tmuxBin, "kill-session", "-t", session.tmuxSession]);
    }
  }

  async observeEvents(
    session: HarnessSessionContext,
    onEvent: (event: NormalizedHarnessEvent) => void,
    options?: { fromBeginning?: boolean },
  ): Promise<() => void> {
    const existing = this.watchers.get(session.sessionId);
    const resolvedPath =
      session.transcriptPath ??
      (session.externalSessionId
        ? this.resolveTranscriptPath(session.cwd ?? "", session.externalSessionId)
        : "");

    if (existing && existing.transcriptPath === resolvedPath && resolvedPath) {
      existing.onEvent = onEvent;
      return () => this.unwatch(session.sessionId);
    }
    if (existing) {
      this.unwatch(session.sessionId);
    }

    let initialOffset = 0;
    if (!options?.fromBeginning && resolvedPath && existsSync(resolvedPath)) {
      try {
        initialOffset = statSync(resolvedPath).size;
      } catch {
        initialOffset = 0;
      }
    }

    const brainBaseDir = this.resolveBrainBaseDir(resolvedPath);

    const state: AgyWatchState = {
      sessionId: session.sessionId,
      transcriptPath: resolvedPath,
      byteOffset: initialOffset,
      remainder: "",
      parseState: createAgyParseState(brainBaseDir, session.model),
      onEvent,
      reading: false,
    };
    this.watchers.set(session.sessionId, state);

    if (resolvedPath) {
      this.attachWatchers(state);
      if (options?.fromBeginning) {
        await this.flushNewBytes(state);
      }
    } else {
      // Poll for newly created AGY conversation transcript matching cwd/start time.
      const startedAfter = this.sessionStartTimes.get(session.sessionId) ?? Date.now() - 5_000;
      state.discoveryTimer = setInterval(() => {
        if (state.transcriptPath) return;
        const found = this.findNewestConversationTranscript(startedAfter, session.cwd);
        if (found) {
          state.transcriptPath = found.transcriptPath;
          state.byteOffset = 0;
          if (state.discoveryTimer) {
            clearInterval(state.discoveryTimer);
            state.discoveryTimer = undefined;
          }
          onEvent({
            type: "init",
            discoveredExternalSessionId: found.convId,
            discoveredTranscriptPath: found.transcriptPath,
          });
          this.attachWatchers(state);
          void this.flushNewBytes(state);
        }
      }, 450);
    }

    state.pollTimer = setInterval(() => {
      if (state.transcriptPath) {
        void this.flushNewBytes(state);
      }
    }, 350);

    return () => this.unwatch(session.sessionId);
  }

  async readRecentEvents(
    session: HarnessSessionContext,
    limit = 500,
  ): Promise<NormalizedHarnessEvent[]> {
    const path =
      session.transcriptPath ??
      (session.externalSessionId
        ? this.resolveTranscriptPath(session.cwd ?? "", session.externalSessionId)
        : undefined);
    if (!path || !existsSync(path)) return [];

    const brainBaseDir = this.resolveBrainBaseDir(path);
    const parseState = createAgyParseState(brainBaseDir, session.model);
    const content = await readFile(path, "utf8");
    const events: NormalizedHarnessEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      events.push(...parseAgyTranscriptLine(line, parseState));
    }
    return events.length > limit ? events.slice(events.length - limit) : events;
  }

  async discoverSessions(): Promise<DiscoveredExternalSession[]> {
    const discovered: DiscoveredExternalSession[] = [];
    const activeTmux = await listTmuxPanes(this.exec, this.tmuxBin);
    const externalAgyTmuxByCwd = new Map<string, string>();
    const activeTmuxNames = new Set(activeTmux.map((t) => t.name));

    for (const pane of activeTmux) {
      if (pane.name.startsWith("cw-")) continue;
      if (pane.paneCommand?.toLowerCase().includes("agy") && pane.cwd) {
        externalAgyTmuxByCwd.set(pane.cwd, pane.name);
      }
    }

    const claimedTmux = new Set<string>();
    const cliBrainDir = join(this.config.agyCliHome, "brain");
    discovered.push(
      ...this.scanBrainDirectory(cliBrainDir, "cli", externalAgyTmuxByCwd, claimedTmux, activeTmuxNames),
    );

    if (this.config.enableIdeDiscovery !== false && this.config.agyIdeHome) {
      const ideBrainDir = join(this.config.agyIdeHome, "brain");
      discovered.push(
        ...this.scanBrainDirectory(ideBrainDir, "ide", new Map(), new Set(), activeTmuxNames),
      );
    }

    for (const pane of activeTmux) {
      if (pane.name.startsWith("cw-")) continue;
      if (!pane.paneCommand?.toLowerCase().includes("agy")) continue;
      if (claimedTmux.has(pane.name)) continue;
      discovered.push({
        externalSessionId: `tmux:${pane.name}`,
        harnessId: "agy",
        origin: "tmux",
        controlMode: "interactive",
        cwd: pane.cwd,
        tmuxSession: pane.name,
        isActiveTmux: true,
        updatedAt: new Date().toISOString(),
      });
    }

    return discovered;
  }

  dispose(): void {
    for (const sessionId of [...this.watchers.keys()]) {
      this.unwatch(sessionId);
    }
  }

  private scanBrainDirectory(
    brainDir: string,
    defaultOrigin: "cli" | "ide",
    tmuxByCwd: Map<string, string>,
    claimedTmux: Set<string>,
    activeTmuxNames: Set<string>,
  ): DiscoveredExternalSession[] {
    if (!existsSync(brainDir)) return [];
    const candidates: Array<{ convId: string; path: string; mtimeMs: number }> = [];

    try {
      for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
        if (!existsSync(transcriptPath)) continue;
        try {
          const st = statSync(transcriptPath);
          if (st.size > 0) {
            candidates.push({ convId: entry.name, path: transcriptPath, mtimeMs: st.mtimeMs });
          }
        } catch {
          // Ignore transient stat failure.
        }
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: DiscoveredExternalSession[] = [];

    for (const item of candidates.slice(0, 30)) {
      const meta = inspectAgyTranscript(item.convId, item.path);
      if (!meta) continue;

      const candidateTmux =
        defaultOrigin === "cli" && meta.cwd ? tmuxByCwd.get(meta.cwd) : undefined;
      const matchedTmux =
        candidateTmux && !claimedTmux.has(candidateTmux) ? candidateTmux : undefined;
      if (matchedTmux) claimedTmux.add(matchedTmux);

      const isTmux = Boolean(matchedTmux);
      out.push({
        externalSessionId: item.convId,
        harnessId: "agy",
        origin: isTmux ? "tmux" : defaultOrigin,
        controlMode: isTmux ? "interactive" : "mirror",
        cwd: meta.cwd,
        transcriptPath: item.path,
        tmuxSession: matchedTmux,
        model: meta.model,
        lastMessagePreview: meta.lastMessagePreview,
        messageCount: meta.messageCount,
        isActiveTmux: matchedTmux ? activeTmuxNames.has(matchedTmux) : false,
        updatedAt: meta.updatedAt ?? new Date(item.mtimeMs).toISOString(),
      });
    }

    return out;
  }

  private findNewestConversationTranscript(
    startedAfterMs: number,
    cwd?: string,
  ): { convId: string; transcriptPath: string } | null {
    const brainDir = join(this.config.agyCliHome, "brain");
    if (!existsSync(brainDir)) return null;

    const candidates: Array<{ convId: string; transcriptPath: string; mtimeMs: number }> = [];
    try {
      for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
        if (!existsSync(transcriptPath)) continue;
        const st = statSync(transcriptPath);
        if (st.mtimeMs >= startedAfterMs && st.size > 0) {
          candidates.push({ convId: entry.name, transcriptPath, mtimeMs: st.mtimeMs });
        }
      }
    } catch {
      return null;
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates) {
      if (!cwd) return { convId: c.convId, transcriptPath: c.transcriptPath };
      const meta = inspectAgyTranscript(c.convId, c.transcriptPath);
      if (!meta?.cwd || meta.cwd === cwd) {
        return { convId: c.convId, transcriptPath: c.transcriptPath };
      }
    }
    return null;
  }

  private unwatch(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;
    state.fsWatcher?.close();
    state.dirWatcher?.close();
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.discoveryTimer) clearInterval(state.discoveryTimer);
    this.watchers.delete(sessionId);
  }

  private attachWatchers(state: AgyWatchState): void {
    if (!state.transcriptPath) return;
    if (existsSync(state.transcriptPath)) {
      if (!state.fsWatcher) {
        try {
          state.fsWatcher = watch(state.transcriptPath, () => {
            void this.flushNewBytes(state);
          });
        } catch {
          // Poll timer remains active.
        }
      }
      return;
    }

    const dir = dirname(state.transcriptPath);
    if (existsSync(dir) && !state.dirWatcher) {
      try {
        state.dirWatcher = watch(dir, (_eventType, filename) => {
          if (!filename || state.transcriptPath.endsWith(String(filename))) {
            if (existsSync(state.transcriptPath)) {
              state.dirWatcher?.close();
              state.dirWatcher = undefined;
              this.attachWatchers(state);
              void this.flushNewBytes(state);
            }
          }
        });
      } catch {
        // Poll timer remains active.
      }
    }
  }

  private async flushNewBytes(state: AgyWatchState): Promise<void> {
    if (state.reading || !state.transcriptPath || !existsSync(state.transcriptPath)) return;
    if (!state.fsWatcher) this.attachWatchers(state);

    state.reading = true;
    try {
      const size = statSync(state.transcriptPath).size;
      if (size < state.byteOffset) {
        state.byteOffset = 0;
        state.remainder = "";
      }
      if (size === state.byteOffset) return;

      const deltaLen = size - state.byteOffset;
      const handle = await open(state.transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(deltaLen);
        const { bytesRead } = await handle.read(buffer, 0, deltaLen, state.byteOffset);
        state.byteOffset += bytesRead;
        const chunk = state.remainder + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = chunk.split("\n");
        state.remainder = lines.pop() ?? "";

        for (const line of lines) {
          for (const event of parseAgyTranscriptLine(line, state.parseState)) {
            state.onEvent(event);
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Next poll retries.
    } finally {
      state.reading = false;
    }
  }

  private resolveBrainBaseDir(transcriptPath?: string): string {
    if (transcriptPath) {
      const normalized = transcriptPath.replace(/\\/g, "/");
      const marker = "/.system_generated/logs/transcript.jsonl";
      if (normalized.endsWith(marker)) {
        // <brainDir>/<convId>/.system_generated/logs/transcript.jsonl
        return dirname(dirname(dirname(dirname(transcriptPath))));
      }
      if (this.config.agyIdeHome && transcriptPath.startsWith(this.config.agyIdeHome)) {
        return join(this.config.agyIdeHome, "brain");
      }
    }
    return join(this.config.agyCliHome, "brain");
  }

  private async waitUntilReady(tmuxSession: string): Promise<void> {
    if (this.bootTimeoutMs <= 0) return;
    const deadline = Date.now() + this.bootTimeoutMs;
    while (Date.now() < deadline) {
      const pane = await this.exec([this.tmuxBin, "capture-pane", "-p", "-t", tmuxSession]);
      if (pane.exitCode === 0) {
        const lines = pane.stdout
          .split("\n")
          .map((l) => l.trimEnd())
          .filter((l) => l.trim().length > 0);
        const tail = lines.slice(-5);
        const ready = tail.some(
          (line) =>
            /[❯>]\s*$/.test(line) ||
            /^\s*[❯>](\s|$)/.test(line) ||
            /(?:Type a message|Ask anything)/i.test(line),
        );
        if (ready) return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}
