import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DiscoveredExternalSession } from "@contracts/harness";
import { safeJsonParse, truncate } from "@core/utils";
import type { DiscoverSessionUsecase } from "../application/discover-session.usecase.ts";
import type { TerminalRunnerPort } from "../application/ports.ts";

interface TranscriptMetadata {
  externalSessionId: string;
  cwd?: string;
  lastMessagePreview?: string;
  messageCount: number;
}

function inspectTranscriptMetadata(filePath: string): TranscriptMetadata | null {
  const fileNameId = basename(filePath, ".jsonl");
  if (!fileNameId) return null;

  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let cwd: string | undefined;
    let externalSessionId = fileNameId;
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

      if (parsed["type"] === "user" && !parsed["isMeta"]) {
        const msg = parsed["message"] as { content?: unknown } | undefined;
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
    return { externalSessionId, cwd, lastMessagePreview, messageCount };
  } catch {
    return null;
  }
}

export interface SessionDiscoveryConfig {
  claudeHome: string;
  discoverUsecase: DiscoverSessionUsecase;
  runner: TerminalRunnerPort;
  discoverExternalSessions?: () => Promise<DiscoveredExternalSession[]>;
  watchExternalSessions?: (onUpsert: (session: DiscoveredExternalSession) => void) => () => void;
  pollIntervalMs?: number;
  maxFilesPerScan?: number;
}

export class SessionDiscoveryService {
  private timer?: ReturnType<typeof setInterval>;
  private unwatchExternal?: () => void;
  private scanning = false;
  private readonly fileCache = new Map<
    string,
    { mtimeMs: number; size: number; meta: TranscriptMetadata | null }
  >();

  constructor(private readonly config: SessionDiscoveryConfig) {}

  start(): void {
    if (this.timer) return;
    void this.scanOnce();
    if (this.config.watchExternalSessions && !this.unwatchExternal) {
      this.unwatchExternal = this.config.watchExternalSessions((item) => {
        void this.config.discoverUsecase.execute({
          externalSessionId: item.externalSessionId,
          harnessId: item.harnessId,
          transcriptPath: item.transcriptPath,
          cwd: item.cwd,
          origin: item.origin,
          controlMode: item.controlMode,
          tmuxSession: item.tmuxSession,
          model: item.model,
          title: item.title,
          lastMessagePreview: item.lastMessagePreview,
          messageCount: item.messageCount,
          isActiveTmux: item.isActiveTmux,
        });
      });
    }
    const interval = this.config.pollIntervalMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unwatchExternal?.();
    this.unwatchExternal = undefined;
  }

  async scanOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      if (this.config.discoverExternalSessions) {
        const items = await this.config.discoverExternalSessions().catch(() => []);
        const seenExternalIds = new Set<string>();
        for (const item of items) {
          seenExternalIds.add(item.externalSessionId);
          await this.config.discoverUsecase.execute({
            externalSessionId: item.externalSessionId,
            harnessId: item.harnessId,
            transcriptPath: item.transcriptPath,
            cwd: item.cwd,
            origin: item.origin,
            controlMode: item.controlMode,
            tmuxSession: item.tmuxSession,
            model: item.model,
            title: item.title,
            lastMessagePreview: item.lastMessagePreview,
            messageCount: item.messageCount,
            isActiveTmux: item.isActiveTmux,
          });
        }
        this.config.discoverUsecase.reconcileStaleExternalTmux(seenExternalIds);
        return;
      }

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
                // Ignore transient file stat error.
              }
            }
          } catch {
            // Ignore unreadable directory.
          }
        }

        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const limit = this.config.maxFilesPerScan ?? 40;

        for (const item of candidates.slice(0, limit)) {
          const cached = this.fileCache.get(item.path);
          let meta: TranscriptMetadata | null;
          if (cached && cached.mtimeMs === item.mtimeMs && cached.size === item.size) {
            meta = cached.meta;
          } else {
            meta = inspectTranscriptMetadata(item.path);
            this.fileCache.set(item.path, { mtimeMs: item.mtimeMs, size: item.size, meta });
          }
          if (!meta) continue;

          const candidateTmux = meta.cwd ? externalClaudeTmuxByCwd.get(meta.cwd) : undefined;
          const matchedTmux =
            candidateTmux && !claimedTmux.has(candidateTmux) ? candidateTmux : undefined;
          if (matchedTmux) claimedTmux.add(matchedTmux);

          await this.config.discoverUsecase.execute({
            externalSessionId: meta.externalSessionId,
            transcriptPath: item.path,
            cwd: meta.cwd,
            origin: matchedTmux ? "tmux" : "cli",
            tmuxSession: matchedTmux,
            lastMessagePreview: meta.lastMessagePreview,
            messageCount: meta.messageCount,
            isActiveTmux: matchedTmux ? activeTmuxNames.has(matchedTmux) : false,
          });
        }
      }

      // Also register active external tmux sessions running claude that haven't written a transcript yet.
      for (const pane of activeTmux) {
        if (pane.name.startsWith("cw-")) continue;
        if (!pane.paneCommand?.toLowerCase().includes("claude")) continue;
        if (claimedTmux.has(pane.name)) continue;
        await this.config.discoverUsecase.execute({
          externalSessionId: `tmux:${pane.name}`,
          cwd: pane.cwd,
          origin: "tmux",
          tmuxSession: pane.name,
          isActiveTmux: true,
        });
      }
    } finally {
      this.scanning = false;
    }
  }
}
