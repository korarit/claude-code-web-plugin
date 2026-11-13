# Issue: `useChat` `submitDecision` and `submitQuestion` clobber `idle` status and re-open resolved Question card on fast responses

## 1. Problem Statement / Reproduction
- **Group**: Group 3 (Antigravity `agy` Live Session Flow & Interactive Controls)
- **Harness**: `agy` (and any fast-responding harness using `InteractionCard`)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Send `"[PERM]"` -> click **Deny** on the `Permission Required: write_file` `InteractionCard`.
  2. In a clean session, send `"[QUESTION]"` -> select `SQLite` -> click **Submit Answer**.
- **Actual Result**:
  - **On Deny (`[PERM]`)**: The assistant replies `"Understood, skipped editing src/app.ts because permission was denied."` and the server saves `status: "idle"`, yet the UI remains stuck showing the `Stop` button and `"Agent is working in tmux session..."` banner, blocking subsequent prompts (`Send` button never reappears). Screenshot: `/tmp/e2e-harness-full/artifacts/group3-agy-session/04-step3-error.png`.
  - **On Question Submit (`[QUESTION]`)**: The assistant replies `"Configured database: SQLite."` and the server saves `status: "idle"` with `pendingInteraction: null`, yet the `Agent has a question` card re-appears (with radio reset to `PostgreSQL`), the sidebar shows `Action Required`, and the footer remains stuck on `Stop`. Screenshot: `/tmp/e2e-harness-full/artifacts/group3-part2-diag/failure.png`.
- **Expected Result**:
  - After clicking **Deny** or **Submit Answer** and receiving the completion + `Stop` SSE events, the `InteractionCard` stays dismissed, status transitions to `idle`, and the `Send` button and composer are immediately ready for the next prompt.

## 2. Root Cause Hypothesis
- In `apps/web/src/features/chat/hooks/useChat.ts`:
  - `submitDecision` (lines 568–579) calls `setStatus(res.session.status)` and `onSessionUpdated?.(res.session)` AFTER `await sendInput(...)` resolves. Because `SendInputUsecase` (`apps/api/src/modules/chat/application/send-input.usecase.ts` lines 148–153) returns `res.session` with `status: "running"`, if `agy` finishes and emits SSE `status: "idle"` (`Stop`) before the HTTP response finishes processing on the client, `res.session` overwrites `"idle"` back to `"running"`.
  - `submitQuestion` (lines 589–608) calls `onSessionUpdated?.(res.session)` where `SendInputUsecase` (lines 280, 301) returns `resolved: false` with the pre-answer `session` snapshot (`status: "waiting_permission"` and `pendingInteraction` still populated). That `onSessionUpdated` updates `activeSession` in `useSessions`, which triggers the `useEffect` in `useChat.ts` lines 166–175 to reset `status` back to `"waiting_permission"` and re-open `pendingInteraction` after SSE `Stop`/`interaction_resolved` had already cleared it.
  - Additionally, `submitQuestion` (lines 593–605) does not reset `submittingInteraction` in a `finally` block.

## 3. Proposed Fix(es)
### Option 1: Rely on SSE/list events for post-input status transitions (do not overwrite newer SSE state with stale `sendInput` HTTP `res.session`)
- Pros: Eliminates the HTTP-vs-SSE race condition in both `submitDecision` and `submitQuestion`; SSE `status` and `interaction_resolved` / `list` events are already authoritative.
- Cons: If an SSE connection were temporarily disconnected, `res.session` wouldn't update local state unless reconciled via `updatedAt`.

### Option 2: Guard `upsertLocal` / `setStatus` with monotonic `updatedAt` timestamps and avoid returning stale `waiting_permission` on `resolved: false`
- Pros: Safe even if SSE is delayed or reconnecting; stale HTTP responses (`res.session.updatedAt < current.updatedAt`) can never regress `idle` back to `running` or `waiting_permission`.
- Cons: Requires comparing ISO timestamps or sequence numbers across `useSessions` and `useChat`.

### Option 3: Combine Option 1 & Option 2: Do not call `onSessionUpdated(res.session)` when `res.resolved === false` in `submitQuestion`, reset `submittingInteraction` in `finally`, and guard `upsertLocal` / `useChat` status sync against stale `updatedAt` snapshots
- Pros: Fixes both the immediate re-open bug and any HTTP-vs-SSE timestamp race across `send`, `submitDecision`, and `submitQuestion`.
- Cons: Small changes across `useChat.ts` and `useSessions.ts`.

### Recommended: Option 3
- Reason: Prevents stale `POST /api/chat/input` and `POST /api/chat/send` responses from ever regressing a completed `idle` turn back to `running` or `waiting_permission`.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 503–509, 562–608):
  - In `submitQuestion`, only call `onSessionUpdated(res.session)` if `res.resolved` is true, and always reset `setSubmittingInteraction(false)` in `finally`.
  - In `submitDecision` and `send`, guard `setStatus` / `onSessionUpdated` so a stale response cannot overwrite a newer `updatedAt` or regress `idle` after `Stop` has arrived.
- `apps/web/src/features/chat/hooks/useSessions.ts`: In `upsertLocal`, ignore incoming session snapshots whose `updatedAt` is older than the currently stored session's `updatedAt`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 3 (`group3-agy-session.ts`):
  - Send `[PERM]` -> click **Deny** -> verify `Send` button returns within 5s and stays `idle`.
  - Send `[QUESTION]` -> select `SQLite` -> click **Submit Answer** -> verify `Agent has a question` stays hidden, `Configured database: SQLite.` renders, and `Send` button returns and stays `idle`.
