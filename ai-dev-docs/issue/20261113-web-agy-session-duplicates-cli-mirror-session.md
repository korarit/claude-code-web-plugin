# Issue: Web-launched Antigravity (`agy`) session creates a duplicate phantom `CLI` mirror session

## 1. Problem Statement / Reproduction
- **Group**: Group 3 (Antigravity `agy` Live Session Flow & Interactive Controls)
- **Harness**: `agy`
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Open Harness Web, select `Antigravity`, choose `gemini-2.5-pro`, enter agent profile `reviewer`, and send `"Hello AGY [SYNC-MARKER:M1]"`.
  2. Observe the `ACTIVE SESSIONS` list in the sidebar after navigation to `/sessions/:id`.
- **Actual Result**:
  - Two sessions appear in `ACTIVE SESSIONS` for the same prompt/transcript:
    1. An `Antigravity` `Web` (`controlMode: "interactive"`) session (the active page).
    2. A duplicate `Antigravity` `CLI` (`controlMode: "mirror"`) session pointing to the exact same `transcriptPath` and `externalSessionId` (`agy-conv-...`), stuck in `status: "running"` with a spinning amber indicator.
  - Screenshot: `/tmp/e2e-harness-full/artifacts/group3-agy-session/02-permission-card.png`, `03-perm-allow-once-done.png`.
- **Expected Result**:
  - Only one `Antigravity` `Web` (`interactive`) session is created, and the `SessionStart` hook and transcript discovery bind to that existing Web session instead of creating a duplicate `CLI` mirror session.

## 2. Root Cause Hypothesis
- `apps/api/src/modules/chat/application/send-message.usecase.ts` lines 171–269 calls `await this.harnessGateway.startOrResumeSession(...)` (line 172) BEFORE calling `this.sessions.save(session)` (line 269).
- Inside `AntigravityHarnessAdapter.startOrResumeSession` (`apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts` lines 216–243), `waitUntilReady(tmuxSession)` waits for `agy` to print its ready prompt.
- During startup (before `waitUntilReady` returns and before `SendMessageUsecase` saves the new session), `agy` posts its `SessionStart` hook to `POST /api/chat/hooks` with `X-Agy-Web-Session-Id: <webSessionId>`, `session_id: <agyConvId>`, and `transcript_path`.
- `HandleHookUsecase.resolveSession` (`apps/api/src/modules/chat/application/handle-hook.usecase.ts` lines 73–78, 442–470) calls `this.sessions.get(hook.sessionId)`, gets `null` because the Web session has not been persisted yet, and falls back to `autoDiscoverSession(hook)` (lines 473–501), creating a duplicate `origin: "cli", controlMode: "mirror"` session with `status: "running"`.
- Later hooks (`Stop`) include `X-Agy-Web-Session-Id`, so they resolve the Web session and leave the phantom `CLI` mirror session stuck in `status: "running"` indefinitely.

## 3. Proposed Fix(es)
### Option 1: Persist the initial Web `Session` in `SendMessageUsecase` before `startOrResumeSession` (with rollback/markStopped on spawn failure)
- Pros: Ensures `this.sessions.get(session.id)` immediately succeeds when `SessionStart` arrives during `waitUntilReady`; also allows `SessionStart` to attach `externalSessionId` and `transcriptPath` directly onto the Web session at byte offset 0.
- Cons: Requires cleaning up or marking `stopped` if `startOrResumeSession` throws before spawning tmux.

### Option 2: Skip `autoDiscoverSession` in `HandleHookUsecase` when `hook.sessionId` (`X-Agy-Web-Session-Id` / `X-Claude-Web-Session-Id`) is explicitly provided
- Pros: Prevents Web-originated hooks from ever creating phantom `cli` mirror sessions even under race conditions.
- Cons: On its own, if the Web session isn't saved yet, `SessionStart` would return `{ matched: false }` and miss attaching `externalSessionId`/`transcriptPath` at `SessionStart`.

### Option 3: Combine Option 1 + Option 2, and deduplicate by `transcriptPath` / `externalSessionId` in `SessionDiscoveryService`
- Pros: Eliminates both the `SessionStart` race and any concurrent `SessionDiscoveryService` scan race; guarantees `externalSessionId` and `transcriptPath` attach cleanly to the Web session.
- Cons: Slightly larger diff across `SendMessageUsecase` and `HandleHookUsecase`.

### Recommended: Option 3 (Persist Web session before spawn + guard `autoDiscoverSession` when explicit `hook.sessionId` is present)
- Reason: Persisting the Web session before `startOrResumeSession` fixes the root ordering bug, while guarding `autoDiscoverSession` when `hook.sessionId` is present prevents phantom `cli` mirror duplicates under any timing.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/send-message.usecase.ts`: Save the initial `session` (and `canonicalSync.ensureSession`) before `startOrResumeSession`, and roll back / delete or mark `stopped` if `startOrResumeSession` throws.
- `apps/api/src/modules/chat/application/handle-hook.usecase.ts`:
  - Line 74: Do not call `autoDiscoverSession(hook)` when `hook.sessionId` was explicitly passed from a Web-launched process.
  - Lines 88–90: Also attach `hook.externalSessionId` (when present) alongside `hook.transcriptPath` so `externalSessionId` is persisted on `SessionStart`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 3 (`group3-agy-session.ts`):
  - Start a new Antigravity session from `/` and verify only **1** session entry (`Antigravity · Web`) is created in `ACTIVE SESSIONS` (no duplicate `Antigravity · CLI` entry).
  - Verify `sessions.json` contains `externalSessionId` and `transcriptPath` on the Web session and no phantom `running` mirror session.
