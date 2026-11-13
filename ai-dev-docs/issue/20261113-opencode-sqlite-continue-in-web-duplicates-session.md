# Issue: Clicking "Continue in Web" on an external OpenCode SQLite session duplicates the session in the sidebar

## 1. Problem Statement / Reproduction
- **Group**: Group 6 (Session Sidebar, External Discovery & Session Lifecycle)
- **Harness**: `opencode`
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Launch Harness Web with an offline OpenCode SQLite session (`ext-oc-sqlite-1`, `"External OpenCode SQLite Session"`) seeded in `opencode.db` (not currently active in the running OpenCode HTTP server).
  2. Click `"External OpenCode SQLite Session"` in `ACTIVE SESSIONS` (`OpenCode` · `CLI` · `mirror`).
  3. Click **Continue in Web** on the `Live Mirror` banner.
  4. Wait ~2 seconds for `SessionDiscoveryService` to poll `opencode.db` and inspect `ACTIVE SESSIONS`.
- **Actual Result**:
  - **Two** identical `"External OpenCode SQLite Session"` entries (`OpenCode` · `CLI`) appear in `ACTIVE SESSIONS`.
  - Searching `"SQLite"` in the sidebar returns `2` matching rows instead of `1`.
  - Furthermore, the newly spawned OpenCode server session (`oc-e2e-...`) starts with an empty server conversation history unless prior SQLite messages are replayed/injected into it.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group6-sidebar-discovery/05-opencode-after-continue.png`, `06-new-opencode-web-session.png`.
- **Expected Result**:
  - Clicking **Continue in Web** adopts the existing `"External OpenCode SQLite Session"` in place without creating a duplicate row in `ACTIVE SESSIONS`, and preserves/syncs prior SQLite transcript context into the interactive OpenCode server session.

## 2. Root Cause Hypothesis
- `OpenCodeHarnessAdapter.startOrResumeSession()` (`apps/api/src/modules/harness/infrastructure/opencode-harness.adapter.ts` lines 208–244) checks `GET /session/${resumeSessionId}` on the running OpenCode server.
- Because `ext-oc-sqlite-1` is an offline SQLite session (not in the live OpenCode server's in-memory/active sessions), `check.ok` is `false` (404), so `startOrResumeSession` calls `POST /session` to create a brand-new server session (`created.id`, e.g., `oc-e2e-...`) with `isNew: true`.
- `ResumeSessionUsecase.execute()` (`apps/api/src/modules/chat/application/resume-session.usecase.ts` lines 87, 116–118) calls `attachExternalSession(updated, started.externalSessionId, this.clock)`, **overwriting** `updated.externalSessionId` from `"ext-oc-sqlite-1"` to `"oc-e2e-..."` (and does not record `"ext-oc-sqlite-1"` as an already-adopted alias/SQLite ID, nor seed the new OpenCode server session with the historical SQLite turns).
- On the next discovery poll (`opencode-harness.adapter.ts` lines 560–606), `seenExtIds` only contains the live server's IDs (`oc-e2e-...`), so `opencode.db` still yields `row.id = "ext-oc-sqlite-1"`.
- `DiscoverSessionUsecase.execute()` (`apps/api/src/modules/chat/application/discover-session.usecase.ts` lines 58–63) looks up `ext-oc-sqlite-1` via `findByExternalSessionId` and `findSessionIdByBinding` — both of which now point to `"oc-e2e-..."` — fails to match the adopted session, and inserts a brand-new duplicate `Session`!

## 3. Proposed Fix(es)
### Option 1: Keep a list/mapping of superseded external IDs (or preserve SQLite external binding) and replay canonical history when OpenCode `startOrResumeSession` falls back to `isNew: true`
- Track adopted/archived external source IDs on the `Session` or in `canonicalSync` (`aliases` / `importedExternalSessionIds`), and ignore/map them in `DiscoverSessionUsecase` when `opencode.db` reports `ext-oc-sqlite-1`.
- When `started.isNew === true` on a resumed OpenCode session that already has canonical/SQLite history, mark `canonicalSync` binding's `lastSyncedSeq = 0` (or inject context via `preparePromptForSend` on the next prompt) so the newly created OpenCode server session receives prior context.
- Pros: Eliminates both the duplicate sidebar entry and the lost conversation context when resuming offline OpenCode SQLite sessions.
- Cons: Requires persisting an alias/source external ID set (or multi-external-ID binding) in `Session` / `CanonicalSyncService`.

### Option 2: Filter out `ext-oc-sqlite-1` inside `OpenCodeHarnessAdapter.discoverSessions` once adopted
- Maintain an in-memory map of `adoptedSqliteId -> serverSessionId` in `OpenCodeHarnessAdapter`.
- Pros: Quick to implement.
- Cons: Lost on API server restart (`restartApiServer()`), causing duplicates to reappear after restart.

### Recommended: Option 1
- Reason: Persisting the original `externalSessionId` as an adopted source ID (or keeping `opencode` binding aliases in SQLite/JSON) survives API restarts AND ensures `CanonicalSyncService` re-injects offline SQLite context when a new OpenCode server session must be created.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/resume-session.usecase.ts` (lines 87, 116–126):
  - When `started.externalSessionId !== existing.externalSessionId`, retain the prior `existing.externalSessionId` as an adopted source alias (or record it in `canonicalSync`) and reset `opencode` binding `lastSyncedSeq` to `0` if `started.isNew` so prior SQLite turns are synced on the next prompt.
- `apps/api/src/modules/chat/application/discover-session.usecase.ts` (lines 52–63):
  - Match `existing` against both current `externalSessionId` and any adopted source external IDs so `opencode.db` never spawns a duplicate session.

## 5. Test / Verification Plan
- Run Playwright E2E Group 6 (`group6-sidebar-discovery.ts`):
  - Click **Continue in Web** on `External OpenCode SQLite Session`.
  - Wait 3+ seconds and reload the page; assert only **1** `"External OpenCode SQLite Session"` row exists (`Search 'SQLite'` returns 1 row).
  - Send a follow-up asking about `README.md` from the SQLite history and verify OpenCode recalls prior context.
