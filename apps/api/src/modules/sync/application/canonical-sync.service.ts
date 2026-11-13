import type { HarnessId } from "@contracts/harness";
import type { SessionControlMode, SessionOrigin } from "@contracts/chat";
import type { CanonicalEventDto, CanonicalSyncSummary, SyncStrategy } from "@contracts/sync";
import { isoNow, systemClock, type Clock } from "@core/time";
import {
  buildSyncSummary,
  computeUnsyncedDelta,
  createCanonicalSession,
  DEFAULT_SYNC_THRESHOLDS,
  getOrInitBinding,
  shouldUseFileSyncFallback,
  type CanonicalEvent,
  type CanonicalSession,
  type HarnessBinding,
  type SyncThresholds,
} from "../domain/canonical-session.entity.ts";
import type { CanonicalSessionRepository } from "../domain/canonical-session.repository.port.ts";
import {
  normalizeEventToCanonical,
  stripInjectedSyncPreamble,
  type RawNormalizableEvent,
} from "./canonical-event-normalizer.ts";
import type {
  CanonicalSyncFileWriterPort,
  OpenCodeNativeImporterPort,
} from "./ports.ts";
import {
  formatDirectVerbatimPrompt,
  formatFileSyncPrompt,
  formatSyncMarkdownDocument,
} from "./verbatim-formatter.ts";

export interface EnsureCanonicalSessionInput {
  sessionId: string;
  harnessId: HarnessId;
  origin?: SessionOrigin;
  controlMode?: SessionControlMode;
  cwd?: string;
  title?: string;
  model?: string;
  externalSessionId?: string;
  tmuxSession?: string;
  transcriptPath?: string;
}

export interface PreparedSyncPayload {
  canonicalSessionId: string;
  targetHarness: HarnessId;
  rawPrompt: string;
  promptToSend: string;
  deltaFromSeq?: number;
  deltaToSeq?: number;
  deltaCount: number;
  strategy?: SyncStrategy;
  syncFilePath?: string;
  largeContextWarning: boolean;
  importedExternalSessionId?: string;
  suggestedTmuxSessionName?: string;
  hasTargetBindingSession?: boolean;
}

const OPENCODE_PART_DELTA_ID_RE = /^(.+)-(\d+)$/;

function parseOpenCodePartDelta(
  harnessId: HarnessId,
  event: RawNormalizableEvent,
): { partId: string; offset: number } | null {
  if (harnessId !== "opencode" || event.type !== "delta" || !event.id || !event.text) {
    return null;
  }
  if (event.agentId && event.agentId !== "main") return null;
  const match = OPENCODE_PART_DELTA_ID_RE.exec(event.id);
  if (!match) return null;
  const offset = Number(match[2]);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return { partId: match[1]!, offset };
}

export class CanonicalSyncService {
  constructor(
    private readonly repo: CanonicalSessionRepository,
    private readonly fileWriter: CanonicalSyncFileWriterPort,
    private readonly clock: Clock = systemClock,
    private readonly thresholds: SyncThresholds = DEFAULT_SYNC_THRESHOLDS,
    private readonly opencodeImporter?: OpenCodeNativeImporterPort,
  ) {}

  ensureSession(input: EnsureCanonicalSessionInput): CanonicalSession {
    const existing = this.repo.get(input.sessionId);
    if (existing) {
      let changed = false;
      const next: CanonicalSession = {
        ...existing,
        bindings: { ...existing.bindings },
      };
      if (input.cwd && !next.cwd) {
        next.cwd = input.cwd;
        changed = true;
      }
      if (input.title && !next.title) {
        next.title = input.title;
        changed = true;
      }
      if (input.origin && next.origin !== input.origin) {
        next.origin = input.origin;
        changed = true;
      }
      if (input.controlMode && next.controlMode !== input.controlMode) {
        next.controlMode = input.controlMode;
        changed = true;
      }
      const prevBinding = getOrInitBinding(next, input.harnessId);
      const mergedBinding: HarnessBinding = {
        ...prevBinding,
        externalSessionId: input.externalSessionId ?? prevBinding.externalSessionId,
        tmuxSession: input.tmuxSession ?? prevBinding.tmuxSession,
        transcriptPath: input.transcriptPath ?? prevBinding.transcriptPath,
        model: input.model ?? prevBinding.model,
      };
      if (
        mergedBinding.externalSessionId !== prevBinding.externalSessionId ||
        mergedBinding.tmuxSession !== prevBinding.tmuxSession ||
        mergedBinding.transcriptPath !== prevBinding.transcriptPath ||
        mergedBinding.model !== prevBinding.model ||
        !existing.bindings[input.harnessId]
      ) {
        next.bindings[input.harnessId] = mergedBinding;
        changed = true;
      }
      if (changed) {
        next.updatedAt = isoNow(this.clock);
        this.repo.saveSession(next);
      }
      return next;
    }

    const created = createCanonicalSession(
      {
        canonicalSessionId: input.sessionId,
        activeHarness: input.harnessId,
        origin: input.origin,
        controlMode: input.controlMode,
        cwd: input.cwd,
        title: input.title,
        initialBinding: {
          harnessId: input.harnessId,
          externalSessionId: input.externalSessionId,
          tmuxSession: input.tmuxSession,
          transcriptPath: input.transcriptPath,
          model: input.model,
          lastSyncedSeq: 0,
        },
      },
      this.clock,
    );
    this.repo.saveSession(created);
    return created;
  }

  updateBinding(
    sessionId: string,
    harnessId: HarnessId,
    meta: Partial<Omit<HarnessBinding, "harnessId">>,
  ): CanonicalSession | null {
    const existing = this.repo.get(sessionId);
    if (!existing) return null;
    const prev = getOrInitBinding(existing, harnessId);
    const updatedBinding: HarnessBinding = {
      ...prev,
      ...meta,
      harnessId,
      lastSyncedSeq:
        meta.lastSyncedSeq !== undefined
          ? Math.max(prev.lastSyncedSeq, meta.lastSyncedSeq)
          : prev.lastSyncedSeq,
    };
    return this.repo.upsertBinding(sessionId, updatedBinding);
  }

  ingestObservedEvent(
    session: EnsureCanonicalSessionInput,
    event: RawNormalizableEvent,
  ): { event: CanonicalEvent | null; inserted: boolean; cleanUserText?: string } {
    const canonical = this.ensureSession(session);
    const ts = event.timestamp ?? isoNow(this.clock);
    const cleanUserText =
      event.type === "user" && event.text ? stripInjectedSyncPreamble(event.text) : undefined;

    // OpenCode streams incremental delta chunks with `<partId>-<offset>` ids; merge into one canonical row.
    const ocPart = parseOpenCodePartDelta(session.harnessId, event);
    if (ocPart && event.text) {
      const { event: stored, inserted } = this.repo.upsertStreamingDelta({
        canonicalSessionId: canonical.canonicalSessionId,
        sourceKey: `opencode:part:${ocPart.partId}`,
        id: event.id ?? `ce-oc-${ocPart.partId}`,
        harnessId: "opencode",
        model: event.model ?? session.model,
        text: event.text,
        offset: ocPart.offset,
        ts,
      });
      const binding = getOrInitBinding(canonical, "opencode");
      if (stored.seq > binding.lastSyncedSeq) {
        this.repo.upsertBinding(canonical.canonicalSessionId, {
          ...binding,
          lastSyncedSeq: stored.seq,
          lastSyncedAt: ts,
          model: stored.model ?? binding.model,
        });
      }
      return { event: stored, inserted, cleanUserText };
    }

    const normalized = normalizeEventToCanonical({
      canonicalSessionId: canonical.canonicalSessionId,
      harnessId: session.harnessId,
      fallbackModel: session.model,
      event,
      fallbackTs: ts,
    });
    if (!normalized) {
      return { event: null, inserted: false, cleanUserText };
    }

    // Prevent duplicating a user prompt that was already recorded by SendMessageUsecase for the current turn.
    if (normalized.role === "user" && normalized.text) {
      const recent = this.repo.listEvents(canonical.canonicalSessionId, { limit: 6 });
      const lastNonSwitch = [...recent]
        .reverse()
        .find((e) => e.kind !== "harness_switched");
      if (
        lastNonSwitch &&
        lastNonSwitch.role === "user" &&
        lastNonSwitch.text?.trim() === normalized.text.trim() &&
        lastNonSwitch.harnessId === normalized.harnessId
      ) {
        if (!lastNonSwitch.sourceKey && normalized.sourceKey) {
          this.repo.attachSourceKey(
            canonical.canonicalSessionId,
            lastNonSwitch.seq,
            normalized.sourceKey,
          );
        }
        return { event: lastNonSwitch, inserted: false, cleanUserText };
      }
    }

    const { event: stored, inserted } = this.repo.appendEvent(normalized);
    if (inserted) {
      const binding = getOrInitBinding(canonical, normalized.harnessId);
      if (stored.seq > binding.lastSyncedSeq) {
        this.repo.upsertBinding(canonical.canonicalSessionId, {
          ...binding,
          lastSyncedSeq: stored.seq,
          lastSyncedAt: ts,
          model: normalized.model ?? binding.model,
        });
      }
    }
    return { event: stored, inserted, cleanUserText };
  }

  async ingestHistory(
    session: EnsureCanonicalSessionInput,
    events: RawNormalizableEvent[],
    markSourceSynced = true,
  ): Promise<{ insertedCount: number; latestSeq: number }> {
    const canonical = this.ensureSession(session);
    let insertedCount = 0;

    // Index existing unkeyed web user prompts chronologically so re-ingesting disk history never duplicates them.
    const existingEvents = this.repo.listEvents(canonical.canonicalSessionId);
    const knownSourceKeys = new Set(
      existingEvents.map((e) => e.sourceKey).filter((k): k is string => Boolean(k)),
    );
    const unkeyedUserQueue = new Map<string, number[]>();
    for (const existingEv of existingEvents) {
      if (!existingEv.sourceKey && existingEv.role === "user" && existingEv.text) {
        const key = `${existingEv.harnessId}\0${existingEv.text.trim()}`;
        const list = unkeyedUserQueue.get(key) ?? [];
        list.push(existingEv.seq);
        unkeyedUserQueue.set(key, list);
      }
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const ts = ev.timestamp ?? isoNow(this.clock);
      const ocPart = parseOpenCodePartDelta(session.harnessId, ev);
      if (ocPart && ev.text) {
        const res = this.repo.upsertStreamingDelta({
          canonicalSessionId: canonical.canonicalSessionId,
          sourceKey: `opencode:part:${ocPart.partId}`,
          id: ev.id ?? `ce-oc-${ocPart.partId}`,
          harnessId: "opencode",
          model: ev.model ?? session.model,
          text: ev.text,
          offset: ocPart.offset,
          ts,
        });
        if (res.inserted) insertedCount++;
        continue;
      }

      const normalized = normalizeEventToCanonical({
        canonicalSessionId: canonical.canonicalSessionId,
        harnessId: session.harnessId,
        fallbackModel: session.model,
        event: ev,
        fallbackTs: ts,
        fallbackKey: ev.id ?? `hist-${i}`,
      });
      if (!normalized) continue;

      if (normalized.sourceKey && knownSourceKeys.has(normalized.sourceKey)) {
        continue;
      }

      if (normalized.role === "user" && normalized.text) {
        const queueKey = `${normalized.harnessId}\0${normalized.text.trim()}`;
        const matchedSeqs = unkeyedUserQueue.get(queueKey);
        if (matchedSeqs && matchedSeqs.length > 0) {
          const matchedSeq = matchedSeqs.shift()!;
          if (normalized.sourceKey) {
            this.repo.attachSourceKey(canonical.canonicalSessionId, matchedSeq, normalized.sourceKey);
            knownSourceKeys.add(normalized.sourceKey);
          }
          continue;
        }
      }

      const res = this.repo.appendEvent(normalized);
      if (res.inserted) insertedCount++;
      if (normalized.sourceKey) knownSourceKeys.add(normalized.sourceKey);
    }

    const latestSeq = this.repo.getLatestSeq(canonical.canonicalSessionId);
    if (markSourceSynced && latestSeq > 0) {
      const binding = getOrInitBinding(canonical, session.harnessId);
      if (latestSeq > binding.lastSyncedSeq) {
        this.repo.upsertBinding(canonical.canonicalSessionId, {
          ...binding,
          lastSyncedSeq: latestSeq,
          lastSyncedAt: isoNow(this.clock),
          model: session.model ?? binding.model,
        });
      }
    }

    return { insertedCount, latestSeq };
  }

  async preparePromptForSend(params: {
    session: EnsureCanonicalSessionInput;
    prompt: string;
    model: string;
  }): Promise<PreparedSyncPayload> {
    const { session, prompt, model } = params;
    const canonical = this.ensureSession(session);
    const targetHarness = session.harnessId;
    const events = this.repo.listEvents(canonical.canonicalSessionId);
    const targetBinding = getOrInitBinding(canonical, targetHarness);
    const delta = computeUnsyncedDelta(events, targetBinding.lastSyncedSeq);

    // Avoid tmux session name collisions when a session has used another tmux-backed harness.
    let suggestedTmuxSessionName = targetBinding.tmuxSession;
    if (!suggestedTmuxSessionName) {
      const hasOtherTmux = Object.entries(canonical.bindings).some(
        ([hid, b]) => hid !== targetHarness && Boolean(b?.tmuxSession),
      );
      if (hasOtherTmux) {
        const cleaned = canonical.canonicalSessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
        suggestedTmuxSessionName = `cw-${cleaned || "s"}-${targetHarness}`;
      }
    }

    const hasExistingBindingSession = Boolean(
      targetBinding.externalSessionId || targetBinding.transcriptPath || targetBinding.tmuxSession,
    );

    if (delta.length === 0) {
      return {
        canonicalSessionId: canonical.canonicalSessionId,
        targetHarness,
        rawPrompt: prompt,
        promptToSend: prompt,
        deltaCount: 0,
        largeContextWarning: false,
        suggestedTmuxSessionName,
        hasTargetBindingSession: hasExistingBindingSession,
      };
    }

    const fromSeq = delta[0]!.seq;
    const toSeq = delta[delta.length - 1]!.seq;
    const cwd = session.cwd ?? canonical.cwd ?? process.cwd();

    // Optional native DB injection for OpenCode via `opencode import`
    if (
      targetHarness === "opencode" &&
      !targetBinding.externalSessionId &&
      this.opencodeImporter?.isEnabled()
    ) {
      const imported = await this.opencodeImporter
        .importSession({
          cwd,
          canonicalSession: canonical,
          events: events.filter((e) => e.kind !== "harness_switched"),
        })
        .catch(() => null);
      if (imported?.externalSessionId) {
        return {
          canonicalSessionId: canonical.canonicalSessionId,
          targetHarness,
          rawPrompt: prompt,
          promptToSend: prompt,
          deltaFromSeq: fromSeq,
          deltaToSeq: toSeq,
          deltaCount: delta.length,
          strategy: "opencode_import",
          largeContextWarning: false,
          importedExternalSessionId: imported.externalSessionId,
          suggestedTmuxSessionName,
          hasTargetBindingSession: true,
        };
      }
    }

    const useFileSync = shouldUseFileSyncFallback(
      delta,
      targetHarness,
      model,
      this.thresholds,
    );

    if (useFileSync) {
      const markdown = formatSyncMarkdownDocument({
        session: canonical,
        delta,
      });
      const syncFilePath = await this.fileWriter.writeSyncFile({
        cwd,
        canonicalSessionId: canonical.canonicalSessionId,
        fromSeq,
        toSeq,
        content: markdown,
      });
      const promptToSend = formatFileSyncPrompt({
        syncFilePath,
        delta,
        targetHarness,
        newPrompt: prompt,
      });
      return {
        canonicalSessionId: canonical.canonicalSessionId,
        targetHarness,
        rawPrompt: prompt,
        promptToSend,
        deltaFromSeq: fromSeq,
        deltaToSeq: toSeq,
        deltaCount: delta.length,
        strategy: "file_sync",
        syncFilePath,
        largeContextWarning: true,
        suggestedTmuxSessionName,
        hasTargetBindingSession: hasExistingBindingSession,
      };
    }

    const promptToSend = formatDirectVerbatimPrompt({
      delta,
      targetHarness,
      newPrompt: prompt,
    });
    return {
      canonicalSessionId: canonical.canonicalSessionId,
      targetHarness,
      rawPrompt: prompt,
      promptToSend,
      deltaFromSeq: fromSeq,
      deltaToSeq: toSeq,
      deltaCount: delta.length,
      strategy: "direct_verbatim",
      largeContextWarning: false,
      suggestedTmuxSessionName,
      hasTargetBindingSession: hasExistingBindingSession,
    };
  }

  commitPromptSent(params: {
    prepared: PreparedSyncPayload;
    model: string;
    externalSessionId?: string;
    tmuxSession?: string;
    transcriptPath?: string;
  }): CanonicalSyncSummary | undefined {
    const { prepared, model, externalSessionId, tmuxSession, transcriptPath } = params;
    const canonical = this.repo.get(prepared.canonicalSessionId);
    if (!canonical) return undefined;

    const now = isoNow(this.clock);
    const { event: userEvent } = this.repo.appendEvent({
      canonicalSessionId: canonical.canonicalSessionId,
      id: `ce-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      harnessId: prepared.targetHarness,
      model,
      role: "user",
      kind: "message",
      text: prepared.rawPrompt,
      syncedTurnsRange:
        prepared.deltaFromSeq !== undefined && prepared.deltaToSeq !== undefined
          ? { fromSeq: prepared.deltaFromSeq, toSeq: prepared.deltaToSeq }
          : undefined,
      syncStrategy: prepared.strategy,
      ts: now,
    });

    const prevBinding = getOrInitBinding(canonical, prepared.targetHarness);
    const nextBinding: HarnessBinding = {
      ...prevBinding,
      harnessId: prepared.targetHarness,
      externalSessionId:
        externalSessionId ?? prepared.importedExternalSessionId ?? prevBinding.externalSessionId,
      tmuxSession: tmuxSession ?? prevBinding.tmuxSession,
      transcriptPath: transcriptPath ?? prevBinding.transcriptPath,
      model,
      lastSyncedSeq: Math.max(prevBinding.lastSyncedSeq, userEvent.seq),
      lastSyncedAt: now,
      syncFilePath: prepared.syncFilePath ?? prevBinding.syncFilePath,
    };

    const nextCanonical: CanonicalSession = {
      ...canonical,
      activeHarness: prepared.targetHarness,
      lastSyncStrategy: prepared.strategy ?? canonical.lastSyncStrategy,
      lastSyncFilePath: prepared.syncFilePath ?? canonical.lastSyncFilePath,
      bindings: {
        ...canonical.bindings,
        [prepared.targetHarness]: nextBinding,
      },
      updatedAt: now,
    };
    this.repo.saveSession(nextCanonical);
    return this.getSyncSummary(canonical.canonicalSessionId, model);
  }

  recordHarnessSwitch(params: {
    sessionId: string;
    fromHarness: HarnessId;
    toHarness: HarnessId;
    targetModel: string;
  }): { switchEvent: CanonicalEvent; summary: CanonicalSyncSummary } | null {
    const canonical = this.repo.get(params.sessionId);
    if (!canonical) return null;

    const events = this.repo.listEvents(params.sessionId);
    const targetBinding = getOrInitBinding(canonical, params.toHarness);
    const pendingDelta = computeUnsyncedDelta(events, targetBinding.lastSyncedSeq);
    const syncedTurnsRange =
      pendingDelta.length > 0
        ? { fromSeq: pendingDelta[0]!.seq, toSeq: pendingDelta[pendingDelta.length - 1]!.seq }
        : undefined;

    const now = isoNow(this.clock);
    const { event: switchEvent } = this.repo.appendEvent({
      canonicalSessionId: params.sessionId,
      id: `ce-switch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      harnessId: params.toHarness,
      model: params.targetModel,
      role: "system",
      kind: "harness_switched",
      switchedFrom: params.fromHarness,
      switchedTo: params.toHarness,
      syncedTurnsRange,
      text: `Switched harness: ${params.fromHarness} -> ${params.toHarness}`,
      ts: now,
    });

    const nextCanonical: CanonicalSession = {
      ...canonical,
      activeHarness: params.toHarness,
      controlMode: "interactive",
      bindings: {
        ...canonical.bindings,
        [params.toHarness]: {
          ...targetBinding,
          model: targetBinding.model ?? params.targetModel,
        },
      },
      updatedAt: now,
    };
    this.repo.saveSession(nextCanonical);

    const updatedEvents = [...events, switchEvent];
    const summary = buildSyncSummary(
      nextCanonical,
      updatedEvents,
      switchEvent.seq,
      params.targetModel,
      this.thresholds,
    );
    return { switchEvent, summary };
  }

  getSyncSummary(sessionId: string, targetModel?: string): CanonicalSyncSummary | undefined {
    const session = this.repo.get(sessionId);
    if (!session) return undefined;
    const events = this.repo.listEvents(sessionId);
    const latestSeq = this.repo.getLatestSeq(sessionId);
    return buildSyncSummary(session, events, latestSeq, targetModel, this.thresholds);
  }

  getCanonicalHistory(
    sessionId: string,
    limit?: number,
  ): { sync: CanonicalSyncSummary; events: CanonicalEventDto[] } | null {
    const session = this.repo.get(sessionId);
    if (!session) return null;
    const allEvents = this.repo.listEvents(sessionId);
    const latestSeq = this.repo.getLatestSeq(sessionId);
    const sync = buildSyncSummary(session, allEvents, latestSeq, undefined, this.thresholds);
    const sliced = limit && allEvents.length > limit ? allEvents.slice(allEvents.length - limit) : allEvents;
    return {
      sync,
      events: sliced.map(({ sourceKey: _sourceKey, ...dto }) => dto),
    };
  }

  getBinding(sessionId: string, harnessId: HarnessId): HarnessBinding | undefined {
    const session = this.repo.get(sessionId);
    return session?.bindings[harnessId];
  }

  findSessionIdByBinding(params: {
    harnessId?: HarnessId;
    externalSessionId?: string;
    transcriptPath?: string;
  }): string | null {
    return this.repo.findByBinding(params)?.canonicalSessionId ?? null;
  }

  deleteSession(sessionId: string): void {
    this.repo.deleteSession(sessionId);
  }
}
