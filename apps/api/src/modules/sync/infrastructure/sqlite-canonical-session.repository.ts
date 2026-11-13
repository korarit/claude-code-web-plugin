import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessId } from "@contracts/harness";
import type { SessionControlMode, SessionOrigin } from "@contracts/chat";
import type {
  CanonicalEventKind,
  CanonicalEventRole,
  CanonicalToolCall,
  SyncStrategy,
  SyncedTurnsRange,
} from "@contracts/sync";
import { safeJsonParse } from "@core/utils";
import type {
  AppendCanonicalEventInput,
  CanonicalEvent,
  CanonicalSession,
  HarnessBinding,
} from "../domain/canonical-session.entity.ts";
import type { CanonicalSessionRepository } from "../domain/canonical-session.repository.port.ts";

interface SessionRow {
  id: string;
  active_harness: string;
  origin: string;
  control_mode: string;
  cwd: string | null;
  title: string | null;
  last_sync_strategy: string | null;
  last_sync_file_path: string | null;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  canonical_session_id: string;
  harness_id: string;
  external_session_id: string | null;
  tmux_session: string | null;
  transcript_path: string | null;
  server_url: string | null;
  model: string | null;
  last_synced_seq: number;
  last_synced_at: string | null;
  sync_file_path: string | null;
}

interface EventRow {
  canonical_session_id: string;
  seq: number;
  id: string;
  source_key: string | null;
  harness_id: string;
  model: string | null;
  role: string;
  kind: string;
  text: string | null;
  tool_calls_json: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input_json: string | null;
  tool_output: string | null;
  files_touched_json: string | null;
  switched_from: string | null;
  switched_to: string | null;
  synced_from_seq: number | null;
  synced_to_seq: number | null;
  sync_strategy: string | null;
  ts: string;
}

function toCanonicalEvent(row: EventRow): CanonicalEvent {
  const syncedTurnsRange: SyncedTurnsRange | undefined =
    row.synced_from_seq !== null && row.synced_to_seq !== null
      ? { fromSeq: row.synced_from_seq, toSeq: row.synced_to_seq }
      : undefined;

  return {
    seq: row.seq,
    id: row.id,
    sourceKey: row.source_key ?? undefined,
    canonicalSessionId: row.canonical_session_id,
    harnessId: row.harness_id as HarnessId,
    model: row.model ?? undefined,
    role: row.role as CanonicalEventRole,
    kind: row.kind as CanonicalEventKind,
    text: row.text ?? undefined,
    toolCalls: row.tool_calls_json
      ? (safeJsonParse<CanonicalToolCall[]>(row.tool_calls_json) ?? undefined)
      : undefined,
    toolName: row.tool_name ?? undefined,
    toolUseId: row.tool_use_id ?? undefined,
    toolInput: row.tool_input_json ? safeJsonParse<unknown>(row.tool_input_json) : undefined,
    toolOutput: row.tool_output ?? undefined,
    filesTouched: row.files_touched_json
      ? (safeJsonParse<string[]>(row.files_touched_json) ?? undefined)
      : undefined,
    switchedFrom: (row.switched_from as HarnessId | null) ?? undefined,
    switchedTo: (row.switched_to as HarnessId | null) ?? undefined,
    syncedTurnsRange,
    syncStrategy: (row.sync_strategy as SyncStrategy | null) ?? undefined,
    ts: row.ts,
  };
}

function toBinding(row: BindingRow): HarnessBinding {
  return {
    harnessId: row.harness_id as HarnessId,
    externalSessionId: row.external_session_id ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    transcriptPath: row.transcript_path ?? undefined,
    serverUrl: row.server_url ?? undefined,
    model: row.model ?? undefined,
    lastSyncedSeq: row.last_synced_seq,
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncFilePath: row.sync_file_path ?? undefined,
  };
}

export class SqliteCanonicalSessionRepository implements CanonicalSessionRepository {
  private readonly db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canonical_sessions (
        id TEXT PRIMARY KEY,
        active_harness TEXT NOT NULL,
        origin TEXT NOT NULL,
        control_mode TEXT NOT NULL,
        cwd TEXT,
        title TEXT,
        last_sync_strategy TEXT,
        last_sync_file_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canonical_bindings (
        canonical_session_id TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        external_session_id TEXT,
        tmux_session TEXT,
        transcript_path TEXT,
        server_url TEXT,
        model TEXT,
        last_synced_seq INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        sync_file_path TEXT,
        PRIMARY KEY (canonical_session_id, harness_id),
        FOREIGN KEY (canonical_session_id) REFERENCES canonical_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS canonical_events (
        canonical_session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        source_key TEXT,
        harness_id TEXT NOT NULL,
        model TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT,
        tool_calls_json TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        tool_input_json TEXT,
        tool_output TEXT,
        files_touched_json TEXT,
        switched_from TEXT,
        switched_to TEXT,
        synced_from_seq INTEGER,
        synced_to_seq INTEGER,
        sync_strategy TEXT,
        ts TEXT NOT NULL,
        PRIMARY KEY (canonical_session_id, seq),
        FOREIGN KEY (canonical_session_id) REFERENCES canonical_sessions(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_events_source_key
        ON canonical_events(canonical_session_id, source_key)
        WHERE source_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_canonical_bindings_external
        ON canonical_bindings(harness_id, external_session_id);
    `);
  }

  get(canonicalSessionId: string): CanonicalSession | null {
    const row = this.db
      .query(`SELECT * FROM canonical_sessions WHERE id = ?`)
      .get(canonicalSessionId) as SessionRow | null;
    if (!row) return null;

    const bindingRows = this.db
      .query(`SELECT * FROM canonical_bindings WHERE canonical_session_id = ?`)
      .all(canonicalSessionId) as BindingRow[];

    const bindings: Partial<Record<HarnessId, HarnessBinding>> = {};
    for (const b of bindingRows) {
      const parsed = toBinding(b);
      bindings[parsed.harnessId] = parsed;
    }

    return {
      canonicalSessionId: row.id,
      activeHarness: row.active_harness as HarnessId,
      origin: row.origin as SessionOrigin,
      controlMode: row.control_mode as SessionControlMode,
      cwd: row.cwd ?? undefined,
      title: row.title ?? undefined,
      lastSyncStrategy: (row.last_sync_strategy as SyncStrategy | null) ?? undefined,
      lastSyncFilePath: row.last_sync_file_path ?? undefined,
      bindings,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  findByBindingExternalId(
    harnessId: HarnessId,
    externalSessionId: string,
  ): CanonicalSession | null {
    const row = this.db
      .query(
        `SELECT canonical_session_id FROM canonical_bindings
         WHERE harness_id = ? AND external_session_id = ?
         LIMIT 1`,
      )
      .get(harnessId, externalSessionId) as { canonical_session_id: string } | null;
    if (!row) return null;
    return this.get(row.canonical_session_id);
  }

  saveSession(session: CanonicalSession): void {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO canonical_sessions (
             id, active_harness, origin, control_mode, cwd, title,
             last_sync_strategy, last_sync_file_path, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             active_harness = excluded.active_harness,
             origin = excluded.origin,
             control_mode = excluded.control_mode,
             cwd = excluded.cwd,
             title = excluded.title,
             last_sync_strategy = excluded.last_sync_strategy,
             last_sync_file_path = excluded.last_sync_file_path,
             updated_at = excluded.updated_at`,
        )
        .run(
          session.canonicalSessionId,
          session.activeHarness,
          session.origin,
          session.controlMode,
          session.cwd ?? null,
          session.title ?? null,
          session.lastSyncStrategy ?? null,
          session.lastSyncFilePath ?? null,
          session.createdAt,
          session.updatedAt,
        );

      for (const binding of Object.values(session.bindings)) {
        if (!binding) continue;
        this.upsertBindingRow(session.canonicalSessionId, binding);
      }
    });
    tx();
  }

  upsertBinding(canonicalSessionId: string, binding: HarnessBinding): CanonicalSession | null {
    const exists = this.db
      .query(`SELECT id FROM canonical_sessions WHERE id = ?`)
      .get(canonicalSessionId) as { id: string } | null;
    if (!exists) return null;

    this.upsertBindingRow(canonicalSessionId, binding);
    return this.get(canonicalSessionId);
  }

  private upsertBindingRow(canonicalSessionId: string, binding: HarnessBinding): void {
    this.db
      .query(
        `INSERT INTO canonical_bindings (
           canonical_session_id, harness_id, external_session_id, tmux_session,
           transcript_path, server_url, model, last_synced_seq, last_synced_at, sync_file_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_session_id, harness_id) DO UPDATE SET
           external_session_id = excluded.external_session_id,
           tmux_session = excluded.tmux_session,
           transcript_path = excluded.transcript_path,
           server_url = excluded.server_url,
           model = excluded.model,
           last_synced_seq = excluded.last_synced_seq,
           last_synced_at = excluded.last_synced_at,
           sync_file_path = excluded.sync_file_path`,
      )
      .run(
        canonicalSessionId,
        binding.harnessId,
        binding.externalSessionId ?? null,
        binding.tmuxSession ?? null,
        binding.transcriptPath ?? null,
        binding.serverUrl ?? null,
        binding.model ?? null,
        binding.lastSyncedSeq,
        binding.lastSyncedAt ?? null,
        binding.syncFilePath ?? null,
      );
  }

  appendEvent(input: AppendCanonicalEventInput): { event: CanonicalEvent; inserted: boolean } {
    const tx = this.db.transaction((): { event: CanonicalEvent; inserted: boolean } => {
      if (input.sourceKey) {
        const existing = this.db
          .query(
            `SELECT * FROM canonical_events
             WHERE canonical_session_id = ? AND source_key = ?
             LIMIT 1`,
          )
          .get(input.canonicalSessionId, input.sourceKey) as EventRow | null;
        if (existing) {
          return { event: toCanonicalEvent(existing), inserted: false };
        }
      }

      const maxRow = this.db
        .query(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM canonical_events WHERE canonical_session_id = ?`,
        )
        .get(input.canonicalSessionId) as { max_seq: number } | null;
      const nextSeq = (maxRow?.max_seq ?? 0) + 1;

      this.db
        .query(
          `INSERT INTO canonical_events (
             canonical_session_id, seq, id, source_key, harness_id, model, role, kind,
             text, tool_calls_json, tool_name, tool_use_id, tool_input_json, tool_output,
             files_touched_json, switched_from, switched_to, synced_from_seq, synced_to_seq,
             sync_strategy, ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.canonicalSessionId,
          nextSeq,
          input.id,
          input.sourceKey ?? null,
          input.harnessId,
          input.model ?? null,
          input.role,
          input.kind,
          input.text ?? null,
          input.toolCalls ? JSON.stringify(input.toolCalls) : null,
          input.toolName ?? null,
          input.toolUseId ?? null,
          input.toolInput !== undefined ? JSON.stringify(input.toolInput) : null,
          input.toolOutput ?? null,
          input.filesTouched ? JSON.stringify(input.filesTouched) : null,
          input.switchedFrom ?? null,
          input.switchedTo ?? null,
          input.syncedTurnsRange?.fromSeq ?? null,
          input.syncedTurnsRange?.toSeq ?? null,
          input.syncStrategy ?? null,
          input.ts,
        );

      const insertedRow = this.db
        .query(
          `SELECT * FROM canonical_events WHERE canonical_session_id = ? AND seq = ?`,
        )
        .get(input.canonicalSessionId, nextSeq) as EventRow;

      return { event: toCanonicalEvent(insertedRow), inserted: true };
    });

    return tx();
  }

  listEvents(
    canonicalSessionId: string,
    options?: { afterSeq?: number; limit?: number },
  ): CanonicalEvent[] {
    const afterSeq = options?.afterSeq ?? 0;
    const rows =
      options?.limit && options.limit > 0
        ? (this.db
            .query(
              `SELECT * FROM (
                 SELECT * FROM canonical_events
                 WHERE canonical_session_id = ? AND seq > ?
                 ORDER BY seq DESC
                 LIMIT ?
               ) ORDER BY seq ASC`,
            )
            .all(canonicalSessionId, afterSeq, options.limit) as EventRow[])
        : (this.db
            .query(
              `SELECT * FROM canonical_events
               WHERE canonical_session_id = ? AND seq > ?
               ORDER BY seq ASC`,
            )
            .all(canonicalSessionId, afterSeq) as EventRow[]);

    return rows.map(toCanonicalEvent);
  }

  getLatestSeq(canonicalSessionId: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM canonical_events WHERE canonical_session_id = ?`,
      )
      .get(canonicalSessionId) as { max_seq: number } | null;
    return row?.max_seq ?? 0;
  }

  deleteSession(canonicalSessionId: string): void {
    this.db.query(`DELETE FROM canonical_sessions WHERE id = ?`).run(canonicalSessionId);
  }

  close(): void {
    this.db.close();
  }
}
