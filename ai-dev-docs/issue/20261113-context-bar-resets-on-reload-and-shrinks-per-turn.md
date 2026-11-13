# Issue: `ContextBar` token usage resets to `0 / 200,000` on reload/restart and shrinks between turns

## 1. Problem Statement / Reproduction
- **Group**: Group 3 (Antigravity `agy` Live Session Flow & Interactive Controls)
- **Harness**: `agy` (and any session replayed from canonical SQLite storage)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Run an `Antigravity` session (`[PERM]` -> Allow Once, `[PERM]` -> Deny, or `[SLOW]`).
  2. Observe the `Context` indicator in the top header (`ContextBar.tsx`) after each turn, then reload `/sessions/:id` (or restart the API server and reload).
- **Actual Result**:
  - During live turns, `Context` fluctuates down when a shorter turn completes (e.g. `Context 155 / 1,000,000 (0%)` after `[PERM]` Allow Once drops to `Context 135 / 1,000,000 (0%)` after `[PERM]` Deny, and `Context 55 / 1,000,000` drops to `Context 50 / 1,000,000` after `[SLOW]` Abort).
  - After `page.reload()` or `restartApiServer()` + `page.reload()`, `Context` resets completely to `Context 0 / 200,000 (0%)` (losing both token count and AGY's `1,000,000` context window).
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group3-agy-session/03-perm-allow-once-done.png`, `04-step3-error.png`, `09-after-restart-reload.png`, `/tmp/e2e-harness-full/artifacts/group3-part3-diag/diag-05-after-restart.png`.
- **Expected Result**:
  - `ContextBar` displays accurate session context/token usage and harness context window (`1,000,000` for AGY) consistently during live turns and after page reload / API server restart.

## 2. Root Cause Hypothesis
- `apps/api/src/index.ts` lines 404–487 (`getCanonicalReplayEvents`) maps `canonical_events` (`message`, `tool_call`, `tool_result`, `error`, `harness_switched`) into SSE replay events, but never emits `result` or `init` usage/contextWindow events, and `CanonicalEvent` does not persist token usage/context window metrics.
- Consequently, on page reload, `useChat.ts` lines 455–459 resets `usage` to `{ inputTokens: 0, outputTokens: 0, contextWindow: 200_000 }`, and replay never updates it.
- Additionally, `apps/web/src/features/chat/hooks/useChat.ts` lines 405–417 overwrites `inputTokens` and `outputTokens` with each `result` event rather than accumulating session output tokens (or tracking cumulative vs latest turn usage).

## 3. Proposed Fix(es)
### Option 1: Emit latest/accumulated `usage` on `SessionInfo` (or replay a synthetic `result` event in `getCanonicalReplayEvents` / `chat.routes.ts`)
- Pros: Restores `ContextBar` tokens and `contextWindow` immediately on page reload and API server restart without schema migrations if derived from transcript/session metadata, or persisted on `Session`.
- Cons: If derived only on disk replay, canonical-only sessions still need stored token fields.

### Option 2: Persist `usage` (`inputTokens`, `outputTokens`, `contextWindow`, `costUsd`) on `Session` / `CanonicalSession` and include it in SSE `init`/`result` replay
- Pros: Works uniformly across all harnesses (`claude`, `agy`, `opencode`), survives restarts, and preserves `contextWindow` (e.g. `1,000,000` for AGY).
- Cons: Requires adding optional usage fields to `Session`/`CanonicalSession` contracts and updating `useChat.ts` accumulation logic.

### Option 3: Persist per-turn/latest `usage` on `CanonicalSession` + emit a synthetic `result` event in `getCanonicalReplayEvents` / `chat.routes.ts`, and accumulate `outputTokens` in `useChat.ts`
- Pros: Cleanly preserves usage across reloads/restarts and prevents `Context` from shrinking when a subsequent step has fewer per-step tokens.
- Cons: Moderate change spanning `sync` and `useChat.ts`.

### Recommended: Option 3
- Reason: Ensures `ContextBar` remains accurate both live and across page reloads / server restarts.

## 4. File-Level Change Plan
- `packages/contracts/src/chat.ts` & `apps/api/src/modules/chat/domain/session.entity.ts`: Store optional `usage` summary (`inputTokens`, `outputTokens`, `contextWindow`, `costUsd`) on session/canonical metadata.
- `apps/api/src/index.ts` (lines 404–487) & `apps/api/src/modules/chat/presentation/chat.routes.ts` (lines 408–420): Emit a replay `result` (or `init`) event with the session's persisted `usage` and `contextWindow` on SSE subscribe.
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 405–417): Clarify/accumulate `outputTokens` vs `inputTokens` cleanly across multi-step `PLANNER_RESPONSE` emissions within a turn.

## 5. Test / Verification Plan
- Run Playwright E2E Group 3 (`group3-agy-session.ts`):
  - Verify `ContextBar` shows `> 0` tokens and `1,000,000` window after M1 and increases/stays non-zero across turns.
  - Verify after `ctx.restartApiServer()` and `page.reload()`, `ContextBar` still displays `> 0` tokens and `1,000,000` window rather than `0 / 200,000 (0%)`.
