# Issue: Command Palette search fails on visible labels with punctuation and drowns commands under fuzzy-matched sessions

## 1. Problem Statement / Reproduction
- **Group**: Group 1 (Boot, Health, Responsive Shell & Global Controls)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `bug` / `ux-confusing`
- **Steps to Reproduce**:
  1. Open Harness Web on desktop (`1440x900`).
  2. Press `Control+k` (or click `Commands`) to open the Command Palette.
  3. Type `Theme: Dark` (matching the visible label `"Theme: Dark"` shown in the Theme group).
  4. Re-open Command Palette and type `opencode`.
- **Actual Result**:
  - Searching `Theme: Dark` displays `"No matching commands or sessions."` (screenshot: `/tmp/e2e-harness-full/artifacts/group1-boot-shell/failure.png`).
  - Searching `opencode` shows 8+ unrelated Claude sessions at the top (`"This session is being continued from a previous conversation..."`) via subsequence fuzzy matching against long session titles/paths, pushing `"Switch harness to OpenCode"` off the bottom of the scroll list (screenshot: `/tmp/e2e-harness-full/artifacts/group1-boot-shell/04-desktop-command-palette.png`).
- **Expected Result**:
  - Typing any visible item label (such as `Theme: Dark`, `Toggle Sound`, `Switch harness to OpenCode`, `Use model sonnet`) matches the corresponding command item.
  - Searching for a harness or action command is not buried beneath unrelated sessions matching scattered characters in long titles/cwds.

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/CommandPalette.tsx`:
  - Line 228 sets `value={`theme ${label} ${opt.value}`}` while the rendered label (`en.ts:233`) is `Theme: {{theme}}` (contains `:`). Because `cmdk` filters against `CommandItem`'s `value` (and `keywords`) rather than rendered JSX text, typing `Theme: Dark` fails to match `theme Dark dark`.
  - Similarly, lines 129 (`sound ...`), 183 (`harness ...`), and 208 (`model ...`) omit the exact rendered text (`t("commandToggleSound", ...)`, `t("commandSwitchHarnessTo", ...)`, `t("commandSwitchModelTo", ...)`).
  - Line 151 puts the full `title` and `cwd` into `value={`session ${title} ${harnessName} ${s.model} ${s.cwd ?? ""}`}` before `Switch Harness` / `Switch Model` / `Theme` groups, allowing `cmdk`'s subsequence matcher to score unrelated long session titles/paths as matches for `opencode` and push harness commands out of view.

## 3. Proposed Fix(es)
### Option 1: Include exact rendered text in `CommandItem` `value` / `keywords`
- Pros: Minimal change in `CommandPalette.tsx`; immediately fixes `Theme: Dark`, `Toggle Sound`, `Switch harness...`, `Use model...`.
- Cons: Does not solve noisy subsequence matches on long session titles/cwds.

### Option 2: Use `keywords` + concise `value` + reorder groups (Actions/Harnesses/Models/Theme before Sessions) or custom `filter`
- Pros: Both fixes exact visible-label matching and prevents long session titles from burying core commands like `Switch harness to OpenCode`.
- Cons: Slightly changes `CommandPalette` group display order when unfiltered (or requires a small custom `filter` function on `<Command>`).

### Option 3: Custom deterministic token filter on `<Command filter={...}>` + full rendered labels in `value`
- Pros: Word/substring-based filtering eliminates false-positive subsequence matches (e.g. `o-p-e-n-c-o-d-e` scattered inside a Claude session title) while supporting `Theme: Dark`.
- Cons: Requires writing and unit-testing a custom `cmdk` filter callback.

### Recommended: Combined Option 1 + Option 3
- Include the exact rendered string in every `CommandItem` `value` (plus `keywords` for aliases like `theme`, `sound`, `harness`, `model`) AND add a clean substring/token scorer via `cmdk`'s `filter` prop in `CommandPalette.tsx` (or `command.tsx`) so scattered subsequence false positives do not flood results.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/components/CommandPalette.tsx`:
  - Update `CommandItem` `value` / `keywords` on Actions, Harnesses, Models, and Theme items to include the exact localized label text.
  - Add a token/substring `filter` function on `CommandDialog` / `Command` (or pass `filter` prop through `CommandDialogProps` in `apps/web/src/components/ui/command.tsx`) and cap/prioritize exact prefix/word matches.

## 5. Test / Verification Plan
- Playwright E2E in `group1-boot-shell.ts`:
  - Open Command Palette (`Control+k`), type `"Theme: Dark"`, verify `"Theme: Dark"` is visible and clicking it applies `.dark` on `<html>`.
  - Type `"opencode"`, verify `"Switch harness to OpenCode"` is immediately visible near the top without unrelated Claude sessions crowding it out.
- Unit test for the custom command filter helper verifying exact label, keyword, and non-matching subsequence behavior.
