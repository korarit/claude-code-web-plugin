# Issue: Cross-harness background discovery clobbers inactive harness binding (`lastSyncedSeq`, `model`, `transcriptPath`) and loses context on switch-back

## 1. Problem Statement / Reproduction
- **Group**: Group 5 (Cross-Harness Switching & Canonical Sync `agy` ⇄ `opencode`)
- **Harness**: `opencode` ⇄ `agy` (any multi-harness session where an inactive harness has an external session discovered by `SessionDiscoveryService`)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Start a new `OpenCode` (`anthropic/claude-sonnet-4-5`) session and send `"Remember secret [SYNC-MARKER:CROSS1] and greet me."`. Wait for idle.
  2. Switch harness to `Antigravity` (`agy`), verify `gemini-2.5-pro` is selected, and send `"What marker did I tell you earlier? [SYNC-MARKER:CROSS2]"`. Wait for completion (allowing ~2s+ for `SessionDiscoveryService` background polling/watching to run).
  3. Open Command Palette (`Ctrl+K`) and switch back to `OpenCode` (`agy` → `opencode`).
  4. Send `"List all markers"` on `OpenCode`.
- **Actual Result**:
  - During the `agy` phase, `SessionDiscoveryService` discovers the older `OpenCode` external session (`oc-e2e-...`) and routes it into `DiscoverSessionUsecase.execute()`.
  - `GET /api/chat/sessions/:id/canonical` after switching back to `OpenCode` shows `bindings.opencode` has been corrupted to:
    - `lastSyncedSeq: 5` (equal to `latestSeq` of `agy`'s turns, even though `OpenCode` only ever saw turns `#1–#2`),
    - `model: "gemini-2.5-pro"` (AGY's model instead of `anthropic/claude-sonnet-4-5`),
    - `transcriptPath` pointing to AGY's `transcript.jsonl`.
  - Consequently, switching back `agy` → `opencode`:
    - Shows divider `Switched: Antigravity → OpenCode` with **no** `syncedTurnsRange` (`#4–#5` omitted).
    - Leaves header and footer `Model` set to `gemini-2.5-pro` instead of restoring `anthropic/claude-sonnet-4-5` (screenshots: `/tmp/e2e-harness-full/artifacts/group5-cross-harness-sync/05-dir1-switched-back-opencode.png`, `07-dir1-after-reload.png`).
    - Sends `"List all markers"` with **0** delta turns (`delta = []`), so `OpenCode` replies `Remembered markers: CROSS1` and **permanently loses `[SYNC-MARKER:CROSS2]`**.
- **Expected Result**:
  - Re-discovering an inactive harness's external session while another harness is active must never overwrite the inactive binding's `model` or `transcriptPath` with the active harness's metadata, and must never advance `lastSyncedSeq` past turns that that harness never actually received.
  - Switching back `agy` → `opencode` restores `OpenCode`'s prior model (`anthropic/claude-sonnet-4-5`), shows `Switched: Antigravity → OpenCode · synced turns #4–#5`, and injects `CROSS2` so `OpenCode` recalls both `CROSS1` and `CROSS2`.

## 2. Root Cause Hypothesis
- `apps/api/src/modules/chat/application/discover-session.usecase.ts` lines 66–79:
  - When `existing.harnessId !== input.harnessId` (e.g., `existing.harnessId === "agy"` and `input.harnessId === "opencode"`), `DiscoverSessionUsecase` calls:
    ```ts
    await this.canonicalSync.ingestExternalSession({
      ...existing,
      harnessId: input.harnessId,
      externalSessionId: input.externalSessionId,
      transcriptPath: input.transcriptPath ?? existing.transcriptPath,
      tmuxSession: input.tmuxSession,
    });
    ```
  - Spreading `...existing` passes `existing.model` (`"gemini-2.5-pro"`) and `existing.transcriptPath` (AGY's transcript path, since OpenCode's `input.transcriptPath` is `undefined`) into `ingestExternalSession` for `"opencode"`.
- `apps/api/src/modules/sync/application/canonical-sync.service.ts`:
  - `ensureSession` (lines 112–128) merges `input.transcriptPath` and `input.model` onto `bindings[input.harnessId]`, clobbering `bindings.opencode.transcriptPath` (previously `undefined`) with AGY's `transcriptPath`.
  - `ingestHistory` (lines 337–348) unconditionally sets `lastSyncedSeq: latestSeq` (`5`) and `model: session.model ?? binding.model` (`"gemini-2.5-pro"`) on `bindings[session.harnessId]` whenever `markSourceSynced && latestSeq > binding.lastSyncedSeq` — even when `session.harnessId` is an **inactive** binding (`canonical.activeHarness !== session.harnessId`) and `latestSeq` includes events created by a *different* active harness (`agy`).

## 3. Proposed Fix(es)
### Option 1: Guard `DiscoverSessionUsecase` and `CanonicalSyncService.ingestHistory` for inactive bindings
- In `DiscoverSessionUsecase` (lines 66–79), construct a clean `SyncSessionState` for `input.harnessId` without inheriting `existing.model` or `existing.transcriptPath` from another harness (pass `model: input.model`, `transcriptPath: input.transcriptPath`, `tmuxSession: input.tmuxSession`).
- In `CanonicalSyncService.ingestHistory` (lines 338–348), only advance `binding.lastSyncedSeq = latestSeq` when `session.harnessId === canonical.activeHarness` (or only advance up to the max `seq` of events actually belonging to `session.harnessId` when `insertedCount > 0`), and never overwrite an existing `binding.model` with a foreign harness's model.
- Pros: Fixes both metadata corruption (`model`, `transcriptPath`) and `lastSyncedSeq` advancement across all harnesses (`claude`, `agy`, `opencode`).
- Cons: Requires updating unit tests for `DiscoverSessionUsecase` and `CanonicalSyncService.ingestHistory` to cover multi-harness cross-discovery.

### Option 2: Skip `ingestExternalSession` in `DiscoverSessionUsecase` when `existing.harnessId !== input.harnessId` and `existing.controlMode === "interactive"`
- Pros: Simple one-line guard.
- Cons: Would miss external CLI/IDE turns appended to an inactive binding if a user manually interacted with the old external session outside Web UI; Option 1 handles both safely.

### Recommended: Option 1
- Reason: Preserves background ingestion for inactive external sessions if new turns genuinely appear in them, while preventing active-harness `model`/`transcriptPath`/`lastSyncedSeq` from leaking onto inactive bindings.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/discover-session.usecase.ts` (lines 66–79):
  - Pass `model: input.model`, `transcriptPath: input.transcriptPath`, `tmuxSession: input.tmuxSession` (do not fall back to `existing.model` / `existing.transcriptPath` when `input.harnessId !== existing.harnessId`).
- `apps/api/src/modules/sync/application/canonical-sync.service.ts` (lines 112–128, 337–348):
  - In `ingestHistory`, only advance `binding.lastSyncedSeq` to `latestSeq` when `canonical.activeHarness === session.harnessId`; for inactive bindings, only advance up to the highest `seq` of events owned by `session.harnessId` (never past turns created by another active harness).
  - Do not overwrite `prevBinding.model` when `input.model` is undefined or from an inactive polling pass unless `prevBinding.model` was unset.

## 5. Test / Verification Plan
- Unit test in `apps/api/src/modules/sync` and `apps/api/src/modules/chat` simulating:
  1. Session active on `opencode` (`seq 1–2`, `model: "anthropic/claude-sonnet-4-5"`), switched to `agy` (`seq 3–5`, `model: "gemini-2.5-pro"`).
  2. `DiscoverSessionUsecase.execute` invoked for `opencode` (`oc-e2e-...`) with `transcriptPath: undefined, model: undefined`.
  3. Assert `bindings.opencode.lastSyncedSeq` remains `2`, `bindings.opencode.model` remains `"anthropic/claude-sonnet-4-5"`, and `bindings.opencode.transcriptPath` remains `undefined`.
- Playwright E2E Group 5 (`group5-cross-harness-sync.ts`):
  - Verify `opencode` → `agy` → `opencode` restores `anthropic/claude-sonnet-4-5`, renders `Switched: Antigravity → OpenCode · synced turns #4–#5`, and `"List all markers"` recalls both `CROSS1` and `CROSS2`.
