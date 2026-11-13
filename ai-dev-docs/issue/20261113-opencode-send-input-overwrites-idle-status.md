# Issue: `SendInputUsecase` overwrites `idle` status back to `running` after OpenCode permission approval and question submission

## 1. Problem Statement / Reproduction
- **Group**: Group 4 (OpenCode `opencode` Live Session Flow & Interactive Controls)
- **Harness**: `opencode` (`server_api` input path)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Start an `OpenCode` session (`openai/gpt-4o`), send `"[PERM]"`, and click **Allow Once** on the `Permission Required: edit` `InteractionCard`.
  2. In a clean `OpenCode` session, send `"[QUESTION]"`, select `Vitest` (or type a custom answer), and click **Submit Answer**.
- **Actual Result**:
  - **On `[PERM]` Allow Once**: `src/app.ts` is updated to version 3 and the assistant streams `"Permission approved (once). Updated src/app.ts to version 3."`, yet the UI remains stuck showing the red `Stop` button, `"Agent is processing your request..."` banner, and a spinning amber dot in the sidebar (preventing any further prompts). Screenshot: `/tmp/e2e-harness-full/artifacts/group4-opencode-session/02-perm-allow-error.png`.
  - **On `[QUESTION]` Submit Answer**: The assistant streams `"Got it! Configuring Vitest for this workspace."` (or `"Configuring Node Test Runner"`), yet the UI remains stuck showing `Stop`, `"Agent is processing your request..."`, and a spinning amber dot in the sidebar. Screenshot: `/tmp/e2e-harness-full/artifacts/group4-part2-diag/diag-03-question-answered.png`.
- **Expected Result**:
  - After OpenCode resolves the interaction and emits `session.idle`, the session transitions to `idle` in both `sessions.json` and the Web UI, restoring the `Send` button and enabling follow-up prompts.

## 2. Root Cause Hypothesis
- In `apps/api/src/modules/chat/application/send-input.usecase.ts`:
  - **Decision path (lines 170–204)**: `const res = await this.harnessGateway.sendInput(...)` (line 170) posts `/permission/:id/reply` to the OpenCode server. While that `await` is in flight, OpenCode resolves the permission, emits `message.part.updated`, `message.updated`, and `session.idle`, and `createObservedEventHandler` (`apps/api/src/modules/chat/application/transcript-sync.ts` lines 142–145) marks the session `idle` in `sessions.save()` and publishes `{ type: "status", status: "idle" }`.
  - Immediately after `await` resumes on line 189, `SendInputUsecase` operates on the **stale pre-await `session` snapshot** (`status: "waiting_permission"`), unconditionally executes `updated = markRunning(updated, this.clock); this.sessions.save(updated);` (lines 190–191), emits `publishListEvent({ type: "upsert", session: updated })` (`running`), and publishes `{ type: "status", status: "running" }` over SSE (lines 198–202) — overwriting `"idle"` back to `"running"`.
  - **Selection / question path (lines 262–279)**: Similarly, after `await this.harnessGateway.sendInput(...)` returns `{ resolved: true }` (line 268), lines 269–272 unconditionally call `updated = markRunning(updated, this.clock); this.sessions.save(updated);` and publish `{ type: "upsert", session: updated }` (`running`) and return `res.session` with `status: "running"`, which clobbers `idle` both on disk and in `useSessions` / `useChat` (`onSessionUpdated(res.session)`).
  - Additionally, in `apps/web/src/features/chat/hooks/useChat.ts` lines 589–608, `submitQuestion` still calls `onSessionUpdated?.(res.session)` unconditionally and lacks a `finally` block to reset `submittingInteraction`.

## 3. Proposed Fix(es)
### Option 1: Re-read the latest session from `this.sessions.get(session.id)` after `await harnessGateway.sendInput(...)` and only transition to `running` if still `waiting_permission`
- Pros: Prevents `SendInputUsecase` from overwriting a `session.idle` transition that already occurred while `sendInput` was awaiting the OpenCode HTTP response; preserves `running` when OpenCode hasn't gone `idle` yet.
- Cons: Still needs care on the client side (`useChat.ts`) if `res.session` arrives out-of-order relative to SSE `status: "idle"`.

### Option 2: Skip `markRunning` / `status: "running"` emission for `server_api` responses and let OpenCode's SSE stream (`session.status` / `session.idle`) be authoritative
- Pros: Zero risk of overwriting `idle` on fast responses.
- Cons: If OpenCode hasn't emitted `session.status: busy` yet or takes time to resume, the UI stays in `waiting_permission` briefly unless `pendingInteraction` is cleared.

### Option 3: Re-read latest `Session` after `await` in `SendInputUsecase` (only call `markRunning` & publish `status: "running"` if `latest.status === "waiting_permission"`) + guard client `useSessions`/`useChat` against stale `updatedAt`
- Pros: Clears `pendingInteraction` immediately when OpenCode is still working (`waiting_permission` -> `running`), never regresses an already-`idle` session back to `running`, and keeps client state monotonic.
- Cons: Small, localized updates in `send-input.usecase.ts` and `useChat.ts`/`useSessions.ts`.

### Recommended: Option 3
- Reason: Completely eliminates the server-side `markRunning` overwrite on fast `server_api` completions while keeping immediate UX feedback for slow turns.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/send-input.usecase.ts`:
  - Lines 188–204 (decision `server_api`/tmux path) and lines 242–252 / 268–279 (`text` & `selection` `res.resolved` paths): Re-fetch `const latest = this.sessions.get(session.id) ?? session;` after `await this.harnessGateway.sendInput(...)`. Clear `pendingInteraction` on `latest`, and only apply `markRunning` / emit `status: "running"` if `latest.status === "waiting_permission"`.
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 562–608): Reset `submittingInteraction` in `finally` for `submitQuestion`, and guard `setStatus` / `onSessionUpdated` against overwriting an already-`idle` state from SSE.

## 5. Test / Verification Plan
- Run Playwright E2E Group 4 (`group4-opencode-session.ts` & `group4-part2-diag.ts`):
  - Send `"[PERM]"` -> click **Allow Once** -> verify `src/app.ts` updates, `Send` button returns within 5s, and sidebar dot turns green (`idle`).
  - Send `"[PERM]"` -> click **Deny** -> verify `Send` button returns and stays `idle`.
  - Send `"[QUESTION]"` -> select `Vitest` -> click **Submit Answer** -> verify `"Got it! Configuring Vitest..."` renders, `Send` button returns, and sidebar dot turns green (`idle`).
