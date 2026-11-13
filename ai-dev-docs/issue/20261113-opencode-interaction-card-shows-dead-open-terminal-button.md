# Issue: OpenCode `InteractionCard` displays a dead-end `"Open Terminal"` button despite having no `tmux` terminal

## 1. Problem Statement / Reproduction
- **Group**: Group 4 (OpenCode `opencode` Live Session Flow & Interactive Controls)
- **Harness**: `opencode` (or any session without `tmuxSession`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Start an `OpenCode` session and send `"[PERM]"` or `"[QUESTION]"`.
  2. Inspect the top-right corner of the rendered `InteractionCard` (`Permission Required: edit` or `Agent has a question`).
- **Actual Result**:
  - An `"Open Terminal"` button is shown on the `InteractionCard`. Clicking it opens the `Terminal` inspector tab, which displays `"Select or start an interactive tmux session to view the live terminal."` because OpenCode runs via HTTP/SSE (`serverApi`) and has no `tmuxSession`.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group4-opencode-session/02-perm-card.png`, `/tmp/e2e-harness-full/artifacts/group4-part2-diag/diag-02-question-card.png`.
- **Expected Result**:
  - `"Open Terminal"` should only appear on `InteractionCard` when the active session actually has an attachable `tmuxSession` (`Boolean(activeSession?.tmuxSession)`).

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/WorkspacePage.tsx` line 396 passes `onOpenTerminal={handleOpenTerminal}` unconditionally to `ChatPanel`, which forwards it to `InteractionCard.tsx` lines 53 & 121 without checking whether `activeSession?.tmuxSession` is defined (unlike `TerminalPanel.tsx` lines 44–48 which checks `Boolean(activeSession?.tmuxSession)`).

## 3. Proposed Fix(es)
### Option 1: Pass `onOpenTerminal={activeSession?.tmuxSession ? handleOpenTerminal : undefined}` in `WorkspacePage.tsx`
- Pros: One-line fix; hides `"Open Terminal"` on OpenCode and any non-tmux session while keeping the fallback button for `claude`/`agy` tmux sessions.
- Cons: None.

### Recommended: Option 1
- Reason: Directly matches `TerminalPanel`'s `canAttach` condition and avoids sending OpenCode users to an empty terminal screen.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/components/WorkspacePage.tsx` (line 396): Change `onOpenTerminal={handleOpenTerminal}` to `onOpenTerminal={activeSession?.tmuxSession ? handleOpenTerminal : undefined}`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 4 (`[PERM]` and `[QUESTION]` on `opencode`):
  - Verify `"Open Terminal"` is NOT rendered inside `InteractionCard` for OpenCode sessions.
- Run Playwright E2E Group 3 (`[PERM]` on `agy`):
  - Verify `"Open Terminal"` IS still rendered for tmux-backed `agy` sessions.
