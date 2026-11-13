# Issue: External `agy` session adopted via "Continue in Web" is immediately marked `stopped` by background discovery

## 1. Problem Statement / Reproduction
- **Group**: Group 6 (Session Sidebar, External Discovery & Session Lifecycle)
- **Harness**: `agy` (also affects `claude` when an external CLI `mirror` session is adopted into a `cw-*` tmux session)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Launch Harness Web with a pre-seeded external Antigravity CLI transcript (`ext-agy-demo`, `"External AGY session: explain utils.ts"`).
  2. Click the session in the sidebar (`Antigravity` · `CLI` · `mirror`), verify the `Live Mirror` banner renders, and click **Continue in Web**.
  3. Observe the session enters `interactive` mode (`idle` green dot, composer enabled).
  4. Send a follow-up prompt `"Follow-up after Continue in Web [SYNC-MARKER:AGY-ADOPT]"` and wait ~2–4 seconds for the background `SessionDiscoveryService` poll to run.
- **Actual Result**:
  - Within ~2 seconds of adopting the external session into a `cw-*` tmux session, the session status flips to `stopped` (`Session stopped. Send a prompt or click Resume to continue.` banner with `Resume Session` button, grey dot in sidebar), and no follow-up reply arrives.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group6-sidebar-discovery/03-agy-continued-in-web.png`, `03b-agy-followup-failed.png`, `failure.png`.
- **Expected Result**:
  - Adopting an external `mirror` session via **Continue in Web** spawns and attaches the `cw-*` tmux session, keeps `status: "idle"` / `"running"` while that `cw-*` tmux session is alive, and allows interactive follow-up turns without background discovery marking it `stopped`.

## 2. Root Cause Hypothesis
- `apps/api/src/modules/chat/application/resume-session.usecase.ts` lines 74–123 spawns a managed tmux session named `cw-<id>` (via `AntigravityHarnessAdapter.startOrResumeSession` at `apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts` line 197), preserves `externalSessionId` (`"ext-agy-demo"`), sets `controlMode: "interactive"`, `tmuxSession: "cw-..."`, and saves the updated session.
- Meanwhile, the periodic external discovery scan calls `AntigravityHarnessAdapter.discoverSessions()` (`apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts` lines 446–451, 526–545):
  - Line 447 skips all managed `cw-*` tmux panes: `if (pane.name.startsWith("cw-")) continue;`.
  - When `scanBrainDirectory` inspects `ext-agy-demo`, `matchedTmux` is `undefined`, so it emits `isActiveTmux: false` (line 544) for `externalSessionId: "ext-agy-demo"`. (Same pattern in `ClaudeHarnessAdapter.discoverSessions` at `claude-harness.adapter.ts` lines 383–402.)
- `DiscoverSessionUsecase.execute()` (`apps/api/src/modules/chat/application/discover-session.usecase.ts` lines 107–109) matches `existing` by `externalSessionId`, sees `updated.tmuxSession` (`"cw-..."`) is truthy and `input.isActiveTmux === false`, and unconditionally calls `markStopped(updated, this.clock)`.
- Thus, every external CLI session adopted into a `cw-*` tmux session is immediately marked `stopped` on the very next discovery tick even though its `cw-*` tmux session is alive. (Note: the missing follow-up assistant turn can also compound with the existing `harnessGateway.observeEvents` watcher reset bug logged in `20261113-harness-gateway-observe-events-unwatches-and-skips-transcript.md`.)

## 3. Proposed Fix(es)
### Option 1: Guard `DiscoverSessionUsecase` against marking `cw-*` / interactive sessions `stopped` based on external `isActiveTmux: false`
- In `DiscoverSessionUsecase.execute()` (`discover-session.usecase.ts` line 107), only apply `input.isActiveTmux === false -> markStopped` when `updated.controlMode !== "interactive"` or `!updated.tmuxSession?.startsWith("cw-")`.
- Pros: Minimal, surgical fix; `cw-*` session liveness is already managed by `reconcilePersistedSessions` and `HandleHookUsecase`.
- Cons: Relies on `cw-` prefix convention unless discovery itself checks `activeTmuxNames.has(updated.tmuxSession)`.

### Option 2: Check whether `existing.tmuxSession` is actually dead before marking `stopped` in `DiscoverSessionUsecase` / `SessionDiscoveryService`
- Pass the full set of active tmux session names (including `cw-*`) or skip `isActiveTmux: false` overwrite when `updated.tmuxSession` starts with `cw-` (or check `runner.listActiveSessions()`).
- Pros: Handles both adopted `cw-*` sessions and externally-started tmux sessions accurately without false `stopped` transitions.
- Cons: Slightly more plumbing if `DiscoverSessionUsecase` queries tmux.

### Recommended: Option 1 (+ check `activeTmuxNames` for `cw-*` if available)
- Reason: External `discoverSessions()` intentionally ignores `cw-*` panes so they aren't discovered as *external* `origin: "tmux"` sessions; therefore `input.isActiveTmux === false` from external discovery must never mark a Web-managed `cw-*` interactive session as `stopped`.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/discover-session.usecase.ts` (lines 107–113):
  - Skip `markStopped` when `updated.controlMode === "interactive"` and `updated.tmuxSession?.startsWith("cw-")`.
- `apps/api/src/modules/chat/application/resume-session.usecase.ts` (lines 106–115):
  - Ensure `adoptToInteractive` cleanly keeps `status: "idle"` and `tmuxSession` without conflicting with external discovery metadata.

## 5. Test / Verification Plan
- Add a unit test for `DiscoverSessionUsecase` verifying that an adopted `interactive` session with `tmuxSession: "cw-demo"` and `externalSessionId: "ext-agy-demo"` stays `"idle"` (not `"stopped"`) when `discoverSessions` reports `{ externalSessionId: "ext-agy-demo", isActiveTmux: false }`.
- Re-run Playwright E2E Group 6 (`group6-sidebar-discovery.ts`):
  - Click **Continue in Web** on `External AGY session: explain utils.ts`.
  - Wait >3 seconds for background discovery, verify no `Session stopped` banner appears, send `"Follow-up after Continue in Web [SYNC-MARKER:AGY-ADOPT]"`, and verify the assistant replies cleanly.
