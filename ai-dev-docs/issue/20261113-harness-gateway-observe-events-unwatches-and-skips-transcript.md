# Issue: `harnessGateway.observeEvents` tears down active watcher on hooks and skips newly written AGY turns

## 1. Problem Statement / Reproduction
- **Group**: Group 3 (Antigravity `agy` Live Session Flow & Interactive Controls)
- **Harness**: `agy` (and any transcript-watched harness using `harnessGateway.observeEvents`)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Launch a new `Antigravity` session and send `"Hello AGY [SYNC-MARKER:M1]"`.
  2. Alternatively, restart the API server (`restartApiServer()`), reload `/sessions/:id`, and send `"Follow up after restart [SYNC-MARKER:M2]"`.
- **Actual Result**:
  - The user prompt appears and the session transitions back to `idle` (`Send` button enabled), and `transcript.jsonl` contains the complete `PLANNER_RESPONSE`, yet the assistant response never streams to the Web UI (nor is it persisted into `canonical_events` for the Web session).
  - Even reloading the page before an API restart does not show the missing first assistant response because `canonical_events` already has the user prompt (`canonicalEvents.length > 0`) and `chat.routes.ts` does not fall back to disk transcript replay.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group3-agy-session/01-step1-live.png`, `01b-step1-after-reload.png`, `/tmp/e2e-harness-full/artifacts/group3-part3-diag/failure.png`.
- **Expected Result**:
  - Every `PLANNER_RESPONSE` written to `transcript.jsonl` before or during `Stop` / `PreToolUse` hooks is reliably parsed and streamed live to the Web UI and persisted in `canonical_events`.

## 2. Root Cause Hypothesis
- `apps/api/src/index.ts` lines 258–260 (`harnessGateway.observeEvents`) unconditionally calls `unwatchObserver(session.id)` BEFORE invoking `adapter.observeEvents(...)`.
- This defeats the existing-watcher reuse guard in `AntigravityHarnessAdapter.observeEvents` (`apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts` lines 350–353: `if (existing && existing.transcriptPath === resolvedPath && resolvedPath)`).
- Every hook call (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) enters `HandleHookUsecase.execute()` (`apps/api/src/modules/chat/application/handle-hook.usecase.ts` line 93) and calls `observeHarnessSessionWithSync(next, ...)`, which invokes `unwatchObserver(next.id)`.
- When `agy` writes `PLANNER_RESPONSE` to `transcript.jsonl` and immediately posts `Stop` (within ~5–10ms, before `agyAdapter`'s 350ms `pollTimer` runs), `unwatchObserver` destroys the active watcher (discarding its `byteOffset`) and creates a brand-new watcher with `initialOffset = statSync(resolvedPath).size` (`agy-harness.adapter.ts` lines 359–364) — pointing to EOF *after* the just-written turn, permanently skipping it.
- Additionally, on the first turn when `transcriptPath` was unknown at `SendMessageUsecase` time and only discovered on `Stop`, `observeHarnessSessionWithSync` is called without `{ fromBeginning: true }`, again starting at `statSync(resolvedPath).size` and skipping the entire first turn.

## 3. Proposed Fix(es)
### Option 1: Flush pending bytes before `unwatch` and preserve/reuse existing watcher when `transcriptPath` is unchanged
- Pros: Directly fixes the root cause in `apps/api/src/index.ts` and `agy-harness.adapter.ts`; `HandleHookUsecase` hooks no longer reset `byteOffset` to EOF and skip in-flight lines.
- Cons: Must ensure `fromBeginning: true` is still respected when transitioning from an empty `transcriptPath` (`""`) to a newly discovered `transcriptPath` on the first turn.

### Option 2: Remove `observeHarnessSessionWithSync` from `HandleHookUsecase` when the session is already observed with the same `transcriptPath`
- Pros: Avoids redundant watcher churn on every hook event.
- Cons: Still leaves `harnessGateway.observeEvents` unsafe if called from `SendMessageUsecase` + `reconcilePersistedSessions` concurrently.

### Option 3: Combine Option 1 & Option 2: reuse active watchers without `unwatchObserver` when `transcriptPath` matches, read from `byteOffset = 0` when attaching a newly discovered `transcriptPath` on a live Web session, and flush new bytes synchronously on `Stop` hooks
- Pros: Eliminates both the skipped-bytes race and the 350ms polling delay on `Stop`, making turn completion deterministic and instantaneous.
- Cons: Slightly touches both `index.ts`, `agy-harness.adapter.ts`, and `handle-hook.usecase.ts`.

### Recommended: Option 3
- Reason: Preserving `byteOffset` when `transcriptPath` is unchanged, reading from offset 0 when a Web session discovers its `transcriptPath` for the first time, and flushing before `Stop` marks `idle` guarantees zero missed turns on both initial send and post-restart follow-ups.

## 4. File-Level Change Plan
- `apps/api/src/index.ts` (lines 258–278): Do not call `unwatchObserver(session.id)` if the adapter is already observing the same session/transcript, or let `adapter.observeEvents` manage idempotent re-attachment.
- `apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts` (lines 338–415): When `existing` had `transcriptPath === ""` and a new `resolvedPath` is provided for an active Web session, read from offset `0` (not `statSync.size`); expose/trigger a flush on `Stop` or when `unwatch` is called.
- `apps/api/src/modules/chat/application/handle-hook.usecase.ts` (lines 88–103): Only re-subscribe `observeHarnessSessionWithSync` if `transcriptPath` changed or no observer is active, and pass `{ fromBeginning: true }` when `transcriptPath` is newly attached to a session with no canonical history yet.

## 5. Test / Verification Plan
- Run Playwright E2E Group 3 (`group3-agy-session.ts` and `group3-part3-diag.ts`):
  - Verify `"Hello AGY [SYNC-MARKER:M1]"` renders its Markdown assistant response immediately via SSE without reload.
  - Verify after `ctx.restartApiServer()` and `page.reload()`, sending `"Follow up after restart [SYNC-MARKER:M2]"` renders its assistant response live via SSE.
