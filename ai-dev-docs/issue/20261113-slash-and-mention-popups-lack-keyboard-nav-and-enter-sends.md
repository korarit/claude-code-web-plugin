# Issue: Slash (`/`) and `@file` autocomplete popups lack keyboard navigation (`ArrowUp`/`ArrowDown`/`Enter`/`Tab`), and `/model` in New Session doesn't sync the Model picker

## 1. Problem Statement / Reproduction
- **Group**: Group 2 (New Session Composer, Harness Picker, Context Controls, Slash/File Autocomplete & Image Upload)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-hard-to-use`
- **Steps to Reproduce**:
  1. Open Harness Web New Session composer (with `Antigravity` or `OpenCode` selected).
  2. Type `@` in the prompt `<textarea>` so the `Workspace Files` popup opens (`src`, `README.md`, `src/app.ts`, `src/utils.ts`).
  3. Press `ArrowDown` or `Tab`/`Enter` expecting to highlight and complete a file mention.
  4. Separately, click `/cmd` in the New Session composer and click `/model gemini-2.5-flash`.
- **Actual Result**:
  - Pressing `ArrowDown` leaves focus in `<textarea>` (`document.activeElement.tagName === "TEXTAREA"`) with no highlighted/active item in either the `Commands` or `Workspace Files` popup.
  - Pressing `Enter` while either popup is open immediately executes `onSend()`, submitting an incomplete `@...` or `/...` message instead of selecting the autocomplete entry.
  - Clicking `/model gemini-2.5-flash` from `/cmd` in a New Session only sets `draft` to `"/model gemini-2.5-flash"` while leaving the `Model` `<select>` on `gemini-2.5-pro`. Sending that draft on a new AGY or OpenCode session sends `"/model gemini-2.5-flash"` as the first user prompt (though `SendMessageUsecase` parses `/model` on the backend, the New Session UI shows stale `gemini-2.5-pro` before sending and sends an unintended empty `/model` turn to start a session instead of switching the pre-session Model selector).
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group2-composer-controls/03-slash-menu-open.png`, `04-file-mention-open.png`.
- **Expected Result**:
  - When the `/` or `@` popup is open, `ArrowUp` / `ArrowDown` moves an active highlight across items, `Enter` or `Tab` inserts the highlighted item (without sending the message), and `Escape` closes the popup.
  - In a New Session (`!activeSession`), selecting `/model <id>` from the slash menu updates the `Model` picker directly (`onModelChange(id)`) and clears the slash draft (or informs the user), rather than leaving a `/model ...` prompt in the textarea.

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/ChatPanel.tsx` lines 754–764 only handle `Escape` and `Enter` (unconditionally calling `onSend()`) in the `<textarea>` `onKeyDown` handler, with no `activeIndex` state or keyboard interception when `slashOpen` or `mentionQuery !== null`.
- `ChatPanel.tsx` lines 184–187 (`insertSlashCommand`) always calls `onDraftChange(cmd)` regardless of whether `!activeSession` and `cmd.startsWith("/model ")`.

## 3. Proposed Fix(es)
### Option 1: Add keyboard highlight index + `ArrowUp`/`ArrowDown`/`Enter`/`Tab` handling for popups, and make `/model <id>` update `onModelChange` in New Session
- Pros: Standard, fast keyboard-first UX for both `/` commands and `@file` mentions; prevents accidental incomplete message sends on `Enter`; `/model` in New Session works intuitively without creating a spurious `/model` turn.
- Cons: Small state additions (`slashIndex`, `mentionIndex`) in `ChatPanel.tsx`.

### Option 2: Move focus into popup buttons on `ArrowDown`
- Pros: Uses browser focus directly.
- Cons: Clunky when continuing to type filter characters (`@ap...`) after pressing `ArrowDown`; `Tab`/`Enter` ergonomics are worse than keeping focus in `<textarea>` with `aria-activedescendant`.

### Option 3: Remove `/model` from `/cmd` in New Session and only show `Enter` warning
- Pros: Minimal diff.
- Cons: Does not solve keyboard navigation for `@file` or `/compact`/`/clear`/`/cost`.

### Recommended: Option 1
- Maintain `activeIndex` (resetting to `0` when filtered items change) in `ChatPanel.tsx`; handle `ArrowDown`, `ArrowUp`, `Tab`, and `Enter` in `textarea` `onKeyDown` when either popup has visible items; and in `insertSlashCommand`, if `!activeSession && cmd.startsWith("/model ")`, call `onModelChange(cmd.slice(7))` and `onDraftChange("")`.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/components/ChatPanel.tsx` (lines 132–197, 477–516, 754–764): Add active selection state, highlight classes, `aria-selected`, keyboard navigation in `onKeyDown`, and New Session `/model` sync in `insertSlashCommand`.

## 5. Test / Verification Plan
- Playwright E2E (`group2-composer-controls.ts`):
  - Type `@` -> press `ArrowDown` -> press `Enter` -> assert `@...` is inserted into draft and NOT sent.
  - Type `/` -> press `ArrowDown` -> press `Tab` -> assert command is selected and NOT sent.
  - In New Session, click `/cmd` -> select `/model gemini-2.5-flash` -> assert `Model` `<select>` updates to `gemini-2.5-flash` and draft is cleared.
