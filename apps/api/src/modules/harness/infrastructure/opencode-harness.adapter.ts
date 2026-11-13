import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { OpenCodeServerError } from "../domain/errors.ts";
import { defaultExec, resolveBinaryPath, type ExecCommandFn } from "./binary-probe.ts";
import { listTmuxPanes } from "./tmux-helpers.ts";
import {
  createOpenCodeMapperState,
  mapOpenCodeEvent,
  unwrapOpenCodeEvent,
  type OpenCodeMapperState,
} from "./opencode-event.mapper.ts";

const DEFAULT_OPENCODE_MODELS = [
  "anthropic/claude-sonnet-4-5",
  "openai/gpt-4o",
  "google/gemini-2.5-pro",
];

export interface OpenCodeServerHandle {
  url: string;
  cwd: string;
  kill: () => void;
}

export type OpenCodeFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenCodeSpawnServerFn = (
  cwd: string,
  port: number,
  bin: string,
) => Promise<OpenCodeServerHandle>;

export interface OpenCodeHarnessAdapterConfig {
  opencodeDataHome: string;
  externalServerUrl?: string;
  opencodeBin?: string;
  tmuxBin?: string;
  exec?: ExecCommandFn;
  fetchFn?: OpenCodeFetchFn;
  spawnServer?: OpenCodeSpawnServerFn;
  basePort?: number;
}

function parseProviderModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash > 0 && slash < model.length - 1) {
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
  }
  return undefined;
}

function formatQuestionAnswers(
  payload: HarnessInputPayload,
): string[][] {
  const questions =
    payload.pendingInteraction?.kind === "question" ? payload.pendingInteraction.questions : [];
  const val = payload.value;
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return questions.map((q) => {
      const answer = val[q.id];
      if (Array.isArray(answer)) return answer.map(String);
      if (answer !== undefined && answer !== null && String(answer).trim()) {
        return [String(answer)];
      }
      return [];
    });
  }
  if (Array.isArray(val)) {
    return [val.map(String)];
  }
  return [[String(val ?? "")]];
}

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  readonly binary: string;
  readonly capabilities: HarnessCapabilities = {
    hooks: false,
    jsonlTranscript: false,
    serverApi: true,
    resume: true,
    subagents: true,
    externalDiscovery: true,
  };

  private readonly tmuxBin: string;
  private readonly exec: ExecCommandFn;
  private readonly fetchFn: OpenCodeFetchFn;
  private readonly serversByCwd = new Map<string, OpenCodeServerHandle>();
  private readonly sessionToServerUrl = new Map<string, string>();
  private readonly observerAborts = new Map<string, AbortController>();
  private readonly externalWatchAborts: AbortController[] = [];
  private nextPort: number;

  constructor(private readonly config: OpenCodeHarnessAdapterConfig) {
    this.binary = config.opencodeBin ?? "opencode";
    this.tmuxBin = config.tmuxBin ?? "tmux";
    this.exec = config.exec ?? defaultExec;
    this.fetchFn = config.fetchFn ?? ((url, init) => fetch(url, init));
    this.nextPort = config.basePort ?? 4196;
  }

  getDefaultModel(): string {
    return DEFAULT_OPENCODE_MODELS[0]!;
  }

  private async resolveBin(): Promise<string> {
    const home = homedir();
    const resolved = await resolveBinaryPath(
      this.binary,
      [join(home, ".opencode", "bin", "opencode"), join(home, ".local", "bin", "opencode")],
      this.exec,
    );
    return resolved ?? this.binary;
  }

  async detectAvailability(): Promise<boolean> {
    if (this.config.externalServerUrl) {
      const healthy = await this.checkHealth(this.config.externalServerUrl);
      if (healthy) return true;
    }
    const home = homedir();
    const resolved = await resolveBinaryPath(
      this.binary,
      [join(home, ".opencode", "bin", "opencode"), join(home, ".local", "bin", "opencode")],
      this.exec,
    );
    return resolved !== null;
  }

  async listModels(): Promise<string[]> {
    const serverUrl = this.anyServerUrl();
    if (serverUrl) {
      try {
        const res = await this.fetchFn(`${serverUrl}/provider`);
        if (res.ok) {
          const data = (await res.json()) as {
            all?: Array<{ id?: string; models?: Record<string, unknown> }>;
            connected?: string[];
          };
          const models: string[] = [];
          const connectedSet = new Set(data.connected ?? []);
          for (const provider of data.all ?? []) {
            if (!provider.id || !provider.models) continue;
            if (connectedSet.size > 0 && !connectedSet.has(provider.id)) continue;
            for (const modelId of Object.keys(provider.models)) {
              models.push(`${provider.id}/${modelId}`);
            }
          }
          if (models.length > 0) return models.slice(0, 40);
        }
      } catch {
        // Fall through to CLI/defaults.
      }
    }

    const bin = await this.resolveBin();
    const cli = await this.exec([bin, "models"]).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    }));
    if (cli.exitCode === 0 && cli.stdout.trim()) {
      const parsed = cli.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("/"));
      if (parsed.length > 0) return parsed.slice(0, 40);
    }

    return [...DEFAULT_OPENCODE_MODELS];
  }

  async listAgentProfiles(): Promise<string[]> {
    const serverUrl = this.anyServerUrl();
    if (!serverUrl) return [];
    try {
      const res = await this.fetchFn(`${serverUrl}/agent`);
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ name?: string; id?: string }>;
      return data
        .map((item) => item.name ?? item.id ?? "")
        .filter((name): name is string => Boolean(name));
    } catch {
      return [];
    }
  }

  async startOrResumeSession(options: StartHarnessSessionOptions): Promise<StartedHarnessSession> {
    const serverUrl = await this.ensureServerForCwd(options.cwd);
    this.sessionToServerUrl.set(options.sessionId, serverUrl);

    if (options.resumeSessionId) {
      const check = await this.fetchFn(`${serverUrl}/session/${encodeURIComponent(options.resumeSessionId)}`, {
        headers: { "x-opencode-directory": options.cwd },
      });
      if (check.ok) {
        return {
          harnessId: "opencode",
          externalSessionId: options.resumeSessionId,
          serverUrl,
          isNew: false,
        };
      }
    }

    const createRes = await this.fetchFn(`${serverUrl}/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": options.cwd,
      },
      body: JSON.stringify({}),
    });
    if (!createRes.ok) {
      throw new OpenCodeServerError(`Failed to create session (${createRes.status})`);
    }
    const created = (await createRes.json()) as { id?: string };
    if (!created.id) {
      throw new OpenCodeServerError("OpenCode POST /session did not return an id");
    }

    return {
      harnessId: "opencode",
      externalSessionId: created.id,
      serverUrl,
      isNew: true,
    };
  }

  async sendPrompt(
    session: HarnessSessionContext,
    prompt: string,
    options?: { model?: string; agentProfile?: string },
  ): Promise<void> {
    const extId = session.externalSessionId;
    if (!extId) {
      throw new OpenCodeServerError("OpenCode session is missing externalSessionId");
    }
    const serverUrl = await this.resolveServerUrl(session);
    const modelObj = parseProviderModel(options?.model ?? session.model);

    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt }],
    };
    if (modelObj) body["model"] = modelObj;
    if (options?.agentProfile) body["agent"] = options.agentProfile;

    const res = await this.fetchFn(`${serverUrl}/session/${encodeURIComponent(extId)}/prompt_async`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session.cwd ? { "x-opencode-directory": session.cwd } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OpenCodeServerError(`prompt_async failed (${res.status}): ${text}`);
    }
  }

  async sendInput(payload: HarnessInputPayload): Promise<HarnessSendInputResult> {
    const serverUrl = await this.resolveServerUrl(payload);
    if (!payload.interactionId) {
      return { handled: false, method: "server_api", resolved: false };
    }

    if (payload.inputType === "decision") {
      const raw = String(payload.value);
      const reply = raw === "allow_once" ? "once" : raw === "always_allow" ? "always" : "reject";
      const res = await this.fetchFn(
        `${serverUrl}/permission/${encodeURIComponent(payload.interactionId)}/reply`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(payload.cwd ? { "x-opencode-directory": payload.cwd } : {}),
          },
          body: JSON.stringify({ reply }),
        },
      );
      if (!res.ok) {
        throw new OpenCodeServerError(`permission reply failed (${res.status})`);
      }
      return { handled: true, method: "server_api", resolved: true };
    }

    if (payload.inputType === "selection" || payload.inputType === "text") {
      const answers = formatQuestionAnswers(payload);
      const res = await this.fetchFn(
        `${serverUrl}/question/${encodeURIComponent(payload.interactionId)}/reply`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(payload.cwd ? { "x-opencode-directory": payload.cwd } : {}),
          },
          body: JSON.stringify({ answers }),
        },
      );
      if (!res.ok) {
        throw new OpenCodeServerError(`question reply failed (${res.status})`);
      }
      return { handled: true, method: "server_api", resolved: true };
    }

    return { handled: false, method: "server_api", resolved: false };
  }

  async abortSession(session: HarnessSessionContext): Promise<void> {
    if (!session.externalSessionId) return;
    const serverUrl = await this.resolveServerUrl(session);
    await this.fetchFn(
      `${serverUrl}/session/${encodeURIComponent(session.externalSessionId)}/abort`,
      {
        method: "POST",
        headers: session.cwd ? { "x-opencode-directory": session.cwd } : undefined,
      },
    ).catch(() => {});
  }

  async observeEvents(
    session: HarnessSessionContext,
    onEvent: (event: NormalizedHarnessEvent) => void,
  ): Promise<() => void> {
    const extId = session.externalSessionId;
    if (!extId) return () => {};

    const existingAbort = this.observerAborts.get(session.sessionId);
    if (existingAbort) existingAbort.abort();

    const controller = new AbortController();
    this.observerAborts.set(session.sessionId, controller);
    const state = createOpenCodeMapperState(session.sessionId, extId);
    const serverUrl = this.anyServerUrl(session);
    if (!serverUrl) {
      this.observerAborts.delete(session.sessionId);
      return () => {};
    }

    void this.consumeSseStream(
      `${serverUrl}/global/event`,
      controller.signal,
      (raw) => {
        for (const mapped of mapOpenCodeEvent(raw, state)) {
          onEvent(mapped);
        }
      },
      session.cwd,
    );

    return () => {
      controller.abort();
      this.observerAborts.delete(session.sessionId);
    };
  }

  async readRecentEvents(
    session: HarnessSessionContext,
    limit = 500,
  ): Promise<NormalizedHarnessEvent[]> {
    if (!session.externalSessionId) return [];
    const serverUrl = this.anyServerUrl(session);
    if (!serverUrl) {
      return this.readRecentEventsFromSqlite(session.sessionId, session.externalSessionId, limit);
    }

    try {
      const res = await this.fetchFn(
        `${serverUrl}/session/${encodeURIComponent(session.externalSessionId)}/message`,
        {
          headers: session.cwd ? { "x-opencode-directory": session.cwd } : undefined,
        },
      );
      if (!res.ok) {
        return this.readRecentEventsFromSqlite(session.sessionId, session.externalSessionId, limit);
      }
      const rows = (await res.json()) as Array<{
        info?: Record<string, unknown>;
        parts?: Array<Record<string, unknown>>;
      }>;
      const state: OpenCodeMapperState = createOpenCodeMapperState(
        session.sessionId,
        session.externalSessionId,
      );
      const events: NormalizedHarnessEvent[] = [];
      for (const row of rows) {
        if (row.info) {
          events.push(
            ...mapOpenCodeEvent(
              { type: "message.updated", properties: { info: row.info } },
              state,
            ),
          );
        }
        for (const part of row.parts ?? []) {
          events.push(
            ...mapOpenCodeEvent(
              { type: "message.part.updated", properties: { part } },
              state,
            ),
          );
        }
      }
      return events.length > limit ? events.slice(events.length - limit) : events;
    } catch {
      return this.readRecentEventsFromSqlite(session.sessionId, session.externalSessionId, limit);
    }
  }

  private readRecentEventsFromSqlite(
    sessionId: string,
    externalSessionId: string,
    limit: number,
  ): NormalizedHarnessEvent[] {
    const dbPath = join(this.config.opencodeDataHome, "opencode.db");
    if (!existsSync(dbPath)) return [];

    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const messageRows = db
          .query(
            `SELECT id, time_created, data
             FROM message
             WHERE session_id = ?
             ORDER BY time_created ASC`,
          )
          .all(externalSessionId) as Array<{ id: string; time_created: number; data: string }>;

        const partRows = db
          .query(
            `SELECT id, message_id, time_created, data
             FROM part
             WHERE session_id = ?
             ORDER BY time_created ASC`,
          )
          .all(externalSessionId) as Array<{
          id: string;
          message_id: string;
          time_created: number;
          data: string;
        }>;

        const partsByMsg = new Map<string, Array<Record<string, unknown>>>();
        for (const p of partRows) {
          const parsedPart = safeJsonParse<Record<string, unknown>>(p.data) ?? {};
          const list = partsByMsg.get(p.message_id) ?? [];
          list.push({
            ...parsedPart,
            id: p.id,
            messageID: p.message_id,
            sessionID: externalSessionId,
          });
          partsByMsg.set(p.message_id, list);
        }

        const state = createOpenCodeMapperState(sessionId, externalSessionId);
        const events: NormalizedHarnessEvent[] = [];
        for (const m of messageRows) {
          const parsedMsg = safeJsonParse<Record<string, unknown>>(m.data) ?? {};
          events.push(
            ...mapOpenCodeEvent(
              {
                type: "message.updated",
                properties: {
                  info: {
                    ...parsedMsg,
                    id: m.id,
                    sessionID: externalSessionId,
                  },
                },
              },
              state,
            ),
          );
          for (const part of partsByMsg.get(m.id) ?? []) {
            events.push(
              ...mapOpenCodeEvent(
                { type: "message.part.updated", properties: { part } },
                state,
              ),
            );
          }
        }
        return events.length > limit ? events.slice(events.length - limit) : events;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  async discoverSessions(): Promise<DiscoveredExternalSession[]> {
    const discovered: DiscoveredExternalSession[] = [];
    const seenExtIds = new Set<string>();
    const activeTmux = await listTmuxPanes(this.exec, this.tmuxBin);
    const tmuxByCwd = new Map<string, string>();
    const activeTmuxNames = new Set(activeTmux.map((t) => t.name));

    for (const pane of activeTmux) {
      if (pane.name.startsWith("cw-")) continue;
      if (pane.paneCommand?.toLowerCase().includes("opencode") && pane.cwd) {
        tmuxByCwd.set(pane.cwd, pane.name);
      }
    }

    // 1. Discover from running OpenCode server(s) if connected.
    const urls = new Set<string>();
    if (this.config.externalServerUrl) urls.add(this.config.externalServerUrl);
    for (const h of this.serversByCwd.values()) urls.add(h.url);

    for (const url of urls) {
      try {
        const res = await this.fetchFn(`${url}/session`);
        if (!res.ok) continue;
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const id = typeof row["id"] === "string" ? row["id"] : undefined;
          if (!id || row["parentID"]) continue;
          seenExtIds.add(id);
          const cwd = typeof row["directory"] === "string" ? row["directory"] : undefined;
          const timeObj = row["time"] as { updated?: number; created?: number } | undefined;
          const updatedMs = timeObj?.updated ?? timeObj?.created ?? Date.now();
          const tmuxName = cwd ? tmuxByCwd.get(cwd) : undefined;
          discovered.push({
            externalSessionId: id,
            harnessId: "opencode",
            origin: tmuxName ? "tmux" : "opencode_server",
            controlMode: tmuxName ? "interactive" : "mirror",
            cwd,
            tmuxSession: tmuxName,
            title: typeof row["title"] === "string" ? row["title"] : undefined,
            isActiveTmux: tmuxName ? activeTmuxNames.has(tmuxName) : false,
            updatedAt: new Date(updatedMs).toISOString(),
          });
        }
      } catch {
        // Ignore unreachable server.
      }
    }

    // 2. Discover from SQLite ~/.local/share/opencode/opencode.db
    const dbPath = join(this.config.opencodeDataHome, "opencode.db");
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const rows = db
            .query(
              `SELECT id, parent_id, directory, title, time_updated
               FROM session
               WHERE parent_id IS NULL
               ORDER BY time_updated DESC
               LIMIT 40`,
            )
            .all() as Array<{
            id: string;
            parent_id: string | null;
            directory: string | null;
            title: string | null;
            time_updated: number;
          }>;

          for (const row of rows) {
            if (!row.id || seenExtIds.has(row.id)) continue;
            seenExtIds.add(row.id);
            const cwd = row.directory ?? undefined;
            const tmuxName = cwd ? tmuxByCwd.get(cwd) : undefined;
            discovered.push({
              externalSessionId: row.id,
              harnessId: "opencode",
              origin: tmuxName ? "tmux" : "cli",
              controlMode: tmuxName ? "interactive" : "mirror",
              cwd,
              tmuxSession: tmuxName,
              title: row.title || undefined,
              lastMessagePreview: row.title ? truncate(row.title, 80) : undefined,
              isActiveTmux: tmuxName ? activeTmuxNames.has(tmuxName) : false,
              updatedAt: new Date(row.time_updated || Date.now()).toISOString(),
            });
          }
        } finally {
          db.close();
        }
      } catch {
        // SQLite DB unavailable or schema differs; skip gracefully.
      }
    }

    return discovered;
  }

  watchExternalSessions(onUpsert: (session: DiscoveredExternalSession) => void): () => void {
    const urls = new Set<string>();
    if (this.config.externalServerUrl) urls.add(this.config.externalServerUrl);
    for (const h of this.serversByCwd.values()) urls.add(h.url);
    if (urls.size === 0) return () => {};

    const aborts: AbortController[] = [];
    for (const url of urls) {
      const controller = new AbortController();
      aborts.push(controller);
      this.externalWatchAborts.push(controller);

      void this.consumeSseStream(`${url}/global/event`, controller.signal, (raw) => {
        const ev = unwrapOpenCodeEvent(raw);
        if (!ev || (ev.type !== "session.created" && ev.type !== "session.updated")) return;
        const info = ev.properties?.["info"] as Record<string, unknown> | undefined;
        const id = typeof info?.["id"] === "string" ? info["id"] : undefined;
        if (!id || info?.["parentID"]) return;
        const cwd = typeof info?.["directory"] === "string" ? info["directory"] : undefined;
        const timeObj = info?.["time"] as { updated?: number; created?: number } | undefined;
        onUpsert({
          externalSessionId: id,
          harnessId: "opencode",
          origin: "opencode_server",
          controlMode: "mirror",
          cwd,
          title: typeof info?.["title"] === "string" ? info["title"] : undefined,
          updatedAt: new Date(timeObj?.updated ?? timeObj?.created ?? Date.now()).toISOString(),
        });
      });
    }

    return () => {
      for (const c of aborts) c.abort();
    };
  }

  async dispose(): Promise<void> {
    for (const controller of this.observerAborts.values()) {
      controller.abort();
    }
    this.observerAborts.clear();
    for (const controller of this.externalWatchAborts) {
      controller.abort();
    }
    this.externalWatchAborts.length = 0;
    for (const handle of this.serversByCwd.values()) {
      try {
        handle.kill();
      } catch {
        // Ignore shutdown errors.
      }
    }
    this.serversByCwd.clear();
  }

  private anyServerUrl(session?: { sessionId?: string; cwd?: string }): string | undefined {
    if (session?.sessionId && this.sessionToServerUrl.has(session.sessionId)) {
      return this.sessionToServerUrl.get(session.sessionId);
    }
    if (session?.cwd && this.serversByCwd.has(session.cwd)) {
      return this.serversByCwd.get(session.cwd)!.url;
    }
    if (this.config.externalServerUrl) return this.config.externalServerUrl;
    const first = this.serversByCwd.values().next().value;
    return first?.url;
  }

  private async resolveServerUrl(session: {
    sessionId: string;
    cwd?: string;
  }): Promise<string> {
    const known = this.anyServerUrl(session);
    if (known) return known;
    return this.ensureServerForCwd(session.cwd || process.cwd());
  }

  private async ensureServerForCwd(cwd: string): Promise<string> {
    if (this.config.externalServerUrl) {
      return this.config.externalServerUrl;
    }
    const existing = this.serversByCwd.get(cwd);
    if (existing && (await this.checkHealth(existing.url))) {
      return existing.url;
    }
    if (existing) {
      existing.kill();
      this.serversByCwd.delete(cwd);
    }

    const port = this.nextPort++;
    const bin = await this.resolveBin();
    const handle = this.config.spawnServer
      ? await this.config.spawnServer(cwd, port, bin)
      : await this.defaultSpawnServer(cwd, port, bin);

    this.serversByCwd.set(cwd, handle);
    return handle.url;
  }

  private async defaultSpawnServer(
    cwd: string,
    port: number,
    bin: string,
  ): Promise<OpenCodeServerHandle> {
    const url = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await this.checkHealth(url)) {
        return {
          url,
          cwd,
          kill: () => {
            try {
              proc.kill();
            } catch {
              // Ignore kill errors.
            }
          },
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    try {
      proc.kill();
    } catch {
      // Ignore cleanup error.
    }
    throw new OpenCodeServerError(`Timed out waiting for opencode serve at ${url}`);
  }

  private async checkHealth(url: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${url}/global/health`);
      if (res.ok) return true;
      const fallback = await this.fetchFn(`${url}/session`);
      return fallback.ok;
    } catch {
      return false;
    }
  }

  private async consumeSseStream(
    url: string,
    signal: AbortSignal,
    onJson: (raw: unknown) => void,
    cwd?: string,
  ): Promise<void> {
    try {
      const res = await this.fetchFn(url, {
        headers: {
          accept: "text/event-stream",
          ...(cwd ? { "x-opencode-directory": cwd } : {}),
        },
        signal,
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLines: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (dataLines.length === 0) continue;
          const parsed = safeJsonParse<unknown>(dataLines.join("\n"));
          if (parsed) onJson(parsed);
        }
      }
    } catch {
      // Aborted or disconnected.
    }
  }
}
