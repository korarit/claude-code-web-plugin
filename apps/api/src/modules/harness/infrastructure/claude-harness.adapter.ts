import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DiscoveredExternalSession, HarnessCapabilities } from "@contracts/harness";
import { safeJsonParse, truncate } from "@core/utils";
import type {
  HarnessAdapter,
  HarnessInputPayload,
  HarnessSendInputResult,
  HarnessSessionContext,
  NormalizedHarnessEvent,
  StartedHarnessSession,
  StartHarnessSessionOptions,
} from "../domain/harness.port.ts";
import { defaultExec, resolveBinaryPath, type ExecCommandFn } from "./binary-probe.ts";
import { buildTuiQuestionKeystrokes } from "./tmux-helpers.ts";

export interface ClaudeRunnerLike {
  isAvailable(): Promise<boolean>;
  ensureSession(options: {
    sessionId: string;
    model: string;
    cwd: string;
    port: number;
    token: string;
    resumeSessionId?: string;
    authMode?: "machine_default" | "api_key";
    apiKey?: string;
    agentProfile?: string;
    tmuxSessionName?: string;
  }): Promise<{ tmuxSession: string; isNew: boolean }>;
  sendPrompt(tmuxSession: string, prompt: string): Promise<void>;
  sendRawKeys(tmuxSession: string, keys: string): Promise<void>;
  sendKeysSequence?(tmuxSession: string, keys: string[]): Promise<void>;
  capturePane?(tmuxSession: string, lines?: number): Promise<string>;
  abortSession(tmuxSession: string): Promise<void>;
  stopSession(tmuxSession: string): Promise<void>;
  listActiveSessions(): Promise<
    Array<{ name: string; cwd?: string; paneCommand?: string; panePid?: number }>
  >;
}

export interface ClaudeWatcherLike {
  resolveTranscriptPath(cwd: string, sessionId: string): string;
  watch(
    sessionId: string,
    transcriptPath: string,
    onEvent: (event: NormalizedHarnessEvent) => void,
    options?: { fromBeginning?: boolean },
  ): Promise<void>;
  unwatch(sessionId: string): void;
  readRecentEvents(transcriptPath: string, limit?: number): Promise<NormalizedHarnessEvent[]>;
}

interface ClaudeTranscriptMeta {
  externalSessionId: string;
  cwd?: string;
  model?: string;
  lastMessagePreview?: string;
  messageCount: number;
}

function inspectClaudeTranscript(filePath: string): ClaudeTranscriptMeta | null {
  const fileNameId = basename(filePath, ".jsonl");
  if (!fileNameId) return null;

  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let cwd: string | undefined;
    let externalSessionId = fileNameId;
    let model: string | undefined;
    let lastMessagePreview: string | undefined;
    let messageCount = 0;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const parsed = safeJsonParse<Record<string, unknown>>(trimmed);
      if (!parsed) continue;

      if (!cwd && typeof parsed["cwd"] === "string" && parsed["cwd"]) {
        cwd = parsed["cwd"];
      }
      if (typeof parsed["sessionId"] === "string" && parsed["sessionId"]) {
        externalSessionId = parsed["sessionId"];
      }
      const msg = parsed["message"] as { content?: unknown; model?: unknown } | undefined;
      if (typeof msg?.model === "string" && msg.model) {
        model = msg.model;
      }

      if (parsed["type"] === "user" && !parsed["isMeta"]) {
        let text = "";
        if (typeof msg?.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg?.content)) {
          const textBlock = msg.content.find(
            (b): b is { type?: string; text?: string } =>
              Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text",
          );
          if (typeof textBlock?.text === "string") text = textBlock.text;
        }
        const cleaned = text.replace(/\s+/g, " ").trim();
        if (cleaned) {
          messageCount += 1;
          lastMessagePreview = truncate(cleaned, 80);
        }
      }
    }

    if (messageCount === 0 && !cwd) return null;
    return { externalSessionId, cwd, model, lastMessagePreview, messageCount };
  } catch {
    return null;
  }
}

export interface ClaudeHarnessAdapterConfig {
  claudeHome: string;
  runner: ClaudeRunnerLike;
  watcher: ClaudeWatcherLike;
  claudeBin?: string;
  defaultCwd?: string;
  exec?: ExecCommandFn;
  maxFilesPerScan?: number;
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude CLI";
  readonly binary: string;
  readonly capabilities: HarnessCapabilities = {
    hooks: true,
    jsonlTranscript: true,
    serverApi: false,
    resume: true,
    subagents: true,
    externalDiscovery: true,
  };

  private readonly exec: ExecCommandFn;
  private readonly fileCache = new Map<
    string,
    { mtimeMs: number; size: number; meta: ClaudeTranscriptMeta | null }
  >();

  constructor(private readonly config: ClaudeHarnessAdapterConfig) {
    this.binary = config.claudeBin ?? "claude";
    this.exec = config.exec ?? defaultExec;
  }

  getDefaultModel(): string {
    return "sonnet";
  }

  async detectAvailability(): Promise<boolean> {
    const home = homedir();
    const resolved = await resolveBinaryPath(
      this.binary,
      [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")],
      this.exec,
    );
    return resolved !== null;
  }

  async listModels(): Promise<string[]> {
    return ["sonnet", "opus", "haiku"];
  }

  async listAgentProfiles(): Promise<string[]> {
    const dirs = [join(this.config.claudeHome, "agents")];
    if (this.config.defaultCwd) {
      dirs.push(join(this.config.defaultCwd, ".claude", "agents"));
    }
    const profiles = new Set<string>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            profiles.add(basename(entry.name, ".md"));
          }
        }
      } catch {
        // Ignore unreadable agent profile directories.
      }
    }
    return [...profiles].sort();
  }

  resolveTranscriptPath(cwd: string, sessionOrExternalId: string): string {
    return this.config.watcher.resolveTranscriptPath(cwd, sessionOrExternalId);
  }

  async startOrResumeSession(options: StartHarnessSessionOptions): Promise<StartedHarnessSession> {
    const ensured = await this.config.runner.ensureSession({
      sessionId: options.sessionId,
      model: options.model,
      cwd: options.cwd,
      port: options.port,
      token: options.token,
      resumeSessionId: options.resumeSessionId,
      authMode: options.authMode,
      apiKey: options.apiKey,
      agentProfile: options.agentProfile,
      tmuxSessionName: options.tmuxSessionName,
    });
    const transcriptPath = this.resolveTranscriptPath(
      options.cwd,
      options.resumeSessionId ?? options.sessionId,
    );
    return {
      harnessId: "claude",
      tmuxSession: ensured.tmuxSession,
      transcriptPath,
      isNew: ensured.isNew,
    };
  }

  async sendPrompt(session: HarnessSessionContext, prompt: string): Promise<void> {
    if (!session.tmuxSession) {
      throw new Error("Claude session is missing tmuxSession");
    }
    await this.config.runner.sendPrompt(session.tmuxSession, prompt);
  }

  async sendInput(payload: HarnessInputPayload): Promise<HarnessSendInputResult> {
    if (!payload.tmuxSession) {
      return { handled: false, method: "tmux", resolved: false };
    }

    if (payload.inputType === "decision") {
      const decision = String(payload.value);
      const fallbackKey =
        decision === "allow_once" ? "1" : decision === "always_allow" ? "2" : "3";
      await this.config.runner.sendRawKeys(payload.tmuxSession, fallbackKey);
      return { handled: true, method: "tmux", resolved: true };
    }

    if (payload.inputType === "selection") {
      const pending = payload.pendingInteraction;
      if (pending && pending.kind === "question") {
        await this.config.runner.capturePane?.(payload.tmuxSession, 40).catch(() => "");
        const steps = buildTuiQuestionKeystrokes(pending.questions, payload.value);
        for (const step of steps) {
          if (step.keys && step.keys.length > 0) {
            if (this.config.runner.sendKeysSequence) {
              await this.config.runner.sendKeysSequence(payload.tmuxSession, step.keys);
            } else {
              for (const k of step.keys) {
                await this.config.runner.sendRawKeys(payload.tmuxSession, k);
              }
            }
          }
          if (step.text) {
            await this.config.runner.sendPrompt(payload.tmuxSession, step.text);
          }
        }
        return { handled: true, method: "tmux", resolved: false };
      }

      const fallbackText = Array.isArray(payload.value)
        ? payload.value.join(", ")
        : typeof payload.value === "string"
          ? payload.value
          : JSON.stringify(payload.value);
      await this.config.runner.sendPrompt(payload.tmuxSession, fallbackText);
      return { handled: true, method: "tmux", resolved: false };
    }

    if (payload.inputType === "key") {
      await this.config.runner.sendRawKeys(payload.tmuxSession, String(payload.value).trim());
      return { handled: true, method: "tmux", resolved: false };
    }

    if (payload.inputType === "text") {
      await this.config.runner.sendPrompt(payload.tmuxSession, String(payload.value ?? ""));
      return { handled: true, method: "tmux", resolved: false };
    }

    return { handled: false, method: "tmux", resolved: false };
  }

  async abortSession(session: HarnessSessionContext): Promise<void> {
    if (session.tmuxSession) {
      await this.config.runner.abortSession(session.tmuxSession);
    }
  }

  async stopSession(session: HarnessSessionContext): Promise<void> {
    if (session.tmuxSession) {
      await this.config.runner.stopSession(session.tmuxSession);
    }
  }

  async observeEvents(
    session: HarnessSessionContext,
    onEvent: (event: NormalizedHarnessEvent) => void,
    options?: { fromBeginning?: boolean },
  ): Promise<() => void> {
    const path =
      session.transcriptPath ??
      (session.cwd
        ? this.resolveTranscriptPath(session.cwd, session.externalSessionId ?? session.sessionId)
        : undefined);
    if (!path) return () => {};
    await this.config.watcher.watch(session.sessionId, path, onEvent, options);
    return () => this.config.watcher.unwatch(session.sessionId);
  }

  async readRecentEvents(
    session: HarnessSessionContext,
    limit = 500,
  ): Promise<NormalizedHarnessEvent[]> {
    if (!session.transcriptPath) return [];
    return this.config.watcher.readRecentEvents(session.transcriptPath, limit);
  }

  async discoverSessions(): Promise<DiscoveredExternalSession[]> {
    const discovered: DiscoveredExternalSession[] = [];
    const activeTmux = await this.config.runner.listActiveSessions().catch(() => []);
    const externalClaudeTmuxByCwd = new Map<string, string>();
    const activeTmuxNames = new Set(activeTmux.map((t) => t.name));

    for (const pane of activeTmux) {
      if (pane.name.startsWith("cw-")) continue;
      if (pane.paneCommand?.toLowerCase().includes("claude") && pane.cwd) {
        externalClaudeTmuxByCwd.set(pane.cwd, pane.name);
      }
    }

    const claimedTmux = new Set<string>();
    const projectsDir = join(this.config.claudeHome, "projects");
    if (existsSync(projectsDir)) {
      const candidates: { path: string; mtimeMs: number; size: number }[] = [];
      for (const dirEntry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!dirEntry.isDirectory()) continue;
        const projPath = join(projectsDir, dirEntry.name);
        try {
          for (const fileEntry of readdirSync(projPath, { withFileTypes: true })) {
            if (
              !fileEntry.isFile() ||
              !fileEntry.name.endsWith(".jsonl") ||
              fileEntry.name.startsWith("agent-")
            ) {
              continue;
            }
            const fullPath = join(projPath, fileEntry.name);
            try {
              const st = statSync(fullPath);
              if (st.size > 0) {
                candidates.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size });
              }
            } catch {
              // Ignore transient stat errors.
            }
          }
        } catch {
          // Ignore unreadable project directory.
        }
      }

      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const limit = this.config.maxFilesPerScan ?? 40;

      for (const item of candidates.slice(0, limit)) {
        const cached = this.fileCache.get(item.path);
        let meta: ClaudeTranscriptMeta | null;
        if (cached && cached.mtimeMs === item.mtimeMs && cached.size === item.size) {
          meta = cached.meta;
        } else {
          meta = inspectClaudeTranscript(item.path);
          this.fileCache.set(item.path, { mtimeMs: item.mtimeMs, size: item.size, meta });
        }
        if (!meta) continue;

        const candidateTmux = meta.cwd ? externalClaudeTmuxByCwd.get(meta.cwd) : undefined;
        const matchedTmux =
          candidateTmux && !claimedTmux.has(candidateTmux) ? candidateTmux : undefined;
        if (matchedTmux) claimedTmux.add(matchedTmux);

        const isTmux = Boolean(matchedTmux);
        discovered.push({
          externalSessionId: meta.externalSessionId,
          harnessId: "claude",
          origin: isTmux ? "tmux" : "cli",
          controlMode: isTmux ? "interactive" : "mirror",
          cwd: meta.cwd,
          transcriptPath: item.path,
          tmuxSession: matchedTmux,
          model: meta.model,
          lastMessagePreview: meta.lastMessagePreview,
          messageCount: meta.messageCount,
          isActiveTmux: matchedTmux ? activeTmuxNames.has(matchedTmux) : false,
          updatedAt: new Date(item.mtimeMs).toISOString(),
        });
      }
    }

    for (const pane of activeTmux) {
      if (pane.name.startsWith("cw-")) continue;
      if (!pane.paneCommand?.toLowerCase().includes("claude")) continue;
      if (claimedTmux.has(pane.name)) continue;
      discovered.push({
        externalSessionId: `tmux:${pane.name}`,
        harnessId: "claude",
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
}
