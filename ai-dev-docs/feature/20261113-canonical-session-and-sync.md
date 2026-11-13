# Feature: Canonical Session Store & Full-Verbatim Cross-Harness Sync (Phase 6)

> **Date:** 2026-11-13
> **Status:** Verified (`30/30` tests, `typecheck`, and `build` passing)
> **Plan:** [phase-06-canonical-session-and-sync.md](../plan/phase-06-canonical-session-and-sync.md)

## Overview

Phase 6 introduces a harness-agnostic **Canonical Session Store** (`modules/sync`) backed by SQLite (`bun:sqlite`) and **Full-Verbatim Lazy Delta Sync** so users can switch mid-conversation between `claude`, `agy`, and `opencode` (`Claude <-> AGY <-> OpenCode`) without lossy summarization or duplicate turn injection.

## Architecture (`apps/api/src/modules/sync` + `packages/contracts` + `apps/web`)

- **Contracts (`packages/contracts/src/sync.ts`, `packages/contracts/src/chat.ts`)**
  - Added canonical DTOs (`CanonicalEventDto`, `HarnessBindingDto`, `CanonicalSyncSummary`, `SyncedTurnsRange`, `SwitchHarnessRequest`, `SwitchHarnessResponse`, `CanonicalSessionResponse`).
  - Extended `SessionInfo` with `syncSummary?: CanonicalSyncSummary` and `ChatStreamEvent` with `"harness_switched"` metadata (`switchedFrom`, `switchedTo`, `syncedTurnsRange`, `syncStrategy`, `syncFilePath`, `canonicalSeq`).
- **Domain (`apps/api/src/modules/sync/domain/`)**
  - `CanonicalSession`, `CanonicalEvent`, `HarnessBinding`, `computeUnsyncedDelta`, `estimateContextWindow`, `shouldUseFileSyncFallback`, `buildSyncSummary`.
  - Repository port `CanonicalSessionRepository` and domain errors (`CanonicalSessionNotFoundError`, `HarnessSwitchBusyError`, `HarnessSwitchUnavailableError`).
- **Application (`apps/api/src/modules/sync/application/`)**
  - `CanonicalEventNormalizer`: strips injected `<!-- harness-web-sync:... -->` preambles so mirrored user echoes are stored cleanly without duplicating synced context; tracks touched file paths and normalized tool calls/results.
  - `VerbatimFormatter`: builds structured full-verbatim delta prompts (`formatDirectVerbatimPrompt`), `.harness-web/sync/<sessionId>-<fromSeq>-<toSeq>.md` documents (`formatSyncMarkdownDocument`, `formatFileSyncPrompt`), and native OpenCode JSON import payloads (`buildOpenCodeImportPayload`).
  - `CanonicalSyncService`: records messages/events from web sends, live transcript observers, and external CLI/IDE discovery, computes per-harness lazy deltas via `lastSyncedSeq`, resolves unique tmux session names across harness switches (`cw-<cleaned>-<targetHarness>`), and advances cursors only after target dispatch/import succeeds.
  - `SwitchHarnessUsecase` & `SendWithSyncUsecase`: handles mid-session switches (including adopting external `mirror` sessions directly into another harness), emits `harness_switched` SSE events, and exposes `GET /api/chat/sessions/:id/canonical` + `POST /api/chat/sessions/:id/switch-harness`.
  - `ExternalSessionIngestService`: auto-ingests discovered CLI/IDE external transcripts into `canonical_events` while the server is running so switching to OpenCode or continuing in Web preserves earlier external turns.
- **Infrastructure (`apps/api/src/modules/sync/infrastructure/`)**
  - `SqliteCanonicalSessionRepository` (`bun:sqlite` WAL database with `canonical_sessions`, `canonical_bindings`, and deduplicated `canonical_events` via `source_key`).
  - `SyncFileWriterAdapter` (`.harness-web/sync/<sessionId>-<fromSeq>-<toSeq>.md`).
  - `OpenCodeNativeImporterAdapter` (optional `opencode import` CLI path when enabled).
- **Frontend (`apps/web/src/features/chat/`)**
  - In-chat header harness switcher (`ChatPanel.tsx` + `useChat.ts`), pending/synced delta badges, `harness_switched` timeline dividers with strategy/turns metadata, and per-message `HarnessBadge` + model attributions via `useTranslation()`.

## Verification

- `bun test`: **30 pass / 0 fail** across 9 test files (355 assertions), including `apps/api/test/phase6-canonical-session-and-sync.test.ts`:
  1. Full-verbatim lazy delta sync across `Claude -> AGY -> Claude -> OpenCode` without duplicate turns, plus restart persistence from SQLite.
  2. Large-history File Sync fallback writing `.harness-web/sync/<sessionId>-<fromSeq>-<toSeq>.md`.
  3. Auto-ingestion of external CLI mirror sessions into the Canonical Store followed by direct switch to `opencode`.
- `bun run typecheck`: Pass across `packages/core`, `packages/contracts`, `@repo/api`, and `@repo/web`.
- `bun run build`: Pass for both Vite (`apps/web/dist`) and Bun (`apps/api/dist`).
