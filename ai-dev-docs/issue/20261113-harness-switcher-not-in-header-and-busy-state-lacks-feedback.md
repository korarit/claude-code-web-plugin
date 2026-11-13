# Issue: In-chat Harness Switcher is tucked into the composer footer rather than the header, and busy state gives no disabled feedback

## 1. Problem Statement / Reproduction
- **Group**: Group 5 (Cross-Harness Switching & Canonical Sync `agy` ⇄ `opencode`)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-hard-to-use`
- **Steps to Reproduce**:
  1. Open or create any interactive session on desktop (`1440x900`) or mobile (`390x844`).
  2. Look at the top header bar (`Harness Web / <title> [Antigravity] [gemini-2.5-pro]`) to switch harnesses.
  3. Send `[SLOW]` to put the session into `running` state, then inspect both the composer footer `Harness` `<select>` and the Command Palette (`Ctrl+K`).
- **Actual Result**:
  - The header displays `<HarnessBadge>` (`Antigravity`) and model (`gemini-2.5-pro`) as static non-interactive pills (`DesktopShell.tsx` lines 143–148; `CompactShell.tsx` lines 87–91 hides `<HarnessBadge>` completely on `<640px` mobile). The actual Harness Switcher `<select aria-label="Harness">` is placed in the bottom composer toolbar alongside `Model`, `Local CLI OAuth`, and `Worktrees` (`ChatPanel.tsx` lines 616–643).
  - When the session is `running` or `waiting_permission` (screenshot: `/tmp/e2e-harness-full/artifacts/group5-cross-harness-sync/08-busy-switch-disabled-palette.png`):
    - The footer `Harness` `<select>` is silently `disabled` with `title={undefined}` (no tooltip or hint explaining why switching is blocked).
    - In the Command Palette (`Ctrl+K`), `WorkspacePage.tsx` line 526 sets `canSwitchHarness = false`, causing `CommandPalette.tsx` line 171 to **completely remove** the entire `"Switch Harness"` group (and `"Switch Model"` group) instead of showing disabled options with an explanation.
- **Expected Result**:
  - Users can discover and trigger harness switching directly from the session header (or clearly linked to the header badge) as well as the composer/Command Palette.
  - While a session is busy (`running` / `waiting_permission`), the Harness Switcher and Command Palette `"Switch Harness"` items remain visible in a disabled state with an explicit hint/tooltip (e.g., `"Wait for the current turn to finish or click Stop before switching harnesses"`).

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/layouts/DesktopShell.tsx` lines 143–148 and `apps/web/src/features/chat/layouts/CompactShell.tsx` lines 87–91:
  - Both shells render `<HarnessBadge>` as a static `<Badge>` without a dropdown/switcher trigger, while `ChatPanel.tsx` lines 616–643 render `<select aria-label={t("switchHarnessLabel")}>` inside `<footer>`.
- `apps/web/src/features/chat/components/ChatPanel.tsx` lines 619–625:
  - `<select>` sets `disabled={(!isMirror && isBusy) || sending || switchingHarness || isReadOnlySubagent}` without any `title` attribute explaining the disabled state.
- `apps/web/src/features/chat/components/WorkspacePage.tsx` lines 525–527 and `CommandPalette.tsx` lines 171–197:
  - `CommandPalette.tsx` line 171 gates the entire `<CommandGroup heading={t("commandGroupHarnesses")}>` on `canSwitchHarness`, hiding all harness-switch commands whenever `isBusy` is true.

## 3. Proposed Fix(es)
### Option 1: Add disabled feedback (`title` + visible disabled Command Palette items) and expose a Header Harness Switcher
- Add an interactive Harness Switcher in `DesktopShell` / `CompactShell` header (or make the header `<HarnessBadge>` a dropdown/button next to the title, keeping the footer control synced or secondary).
- Add `title={isBusy && !isMirror ? t("switchHarnessBusyHint") : undefined}` on the `<select>` control.
- In `CommandPalette.tsx`, render the `Switch Harness` group whenever `harnesses.length > 0` (even if `!canSwitchHarness`), setting `disabled={!canSwitchHarness || disabled}` on each `<CommandItem>` and showing a subtle `"Busy"` badge/hint when `!canSwitchHarness`.
- Pros: Resolves both discoverability from the header and silent disappearance/disabled confusion when busy.
- Cons: Modifies `DesktopShellProps` / `CompactShellProps` to accept harness list & `onSwitchHarness`.

### Option 2: Only add tooltips and keep `Switch Harness` visible (disabled) in Command Palette
- Pros: Minimal diff in `ChatPanel.tsx` and `CommandPalette.tsx` without changing shell headers.
- Cons: Users still have to look at the bottom composer bar rather than the header badge to switch harnesses.

### Recommended: Option 1
- Reason: Making the header badge/control interactive matches user mental models (the session's active harness is displayed in the header), and keeping busy-disabled states visible with clear hints prevents users from thinking harness switching vanished.

## 4. File-Level Change Plan
- `apps/web/src/lib/i18n/locales/en.ts`: Add `switchHarnessBusyHint` (e.g., `"Finish or stop the active turn before switching harnesses"`).
- `apps/web/src/features/chat/components/ChatPanel.tsx` (lines 616–644): Add `title` hint when disabled due to `isBusy`.
- `apps/web/src/features/chat/components/CommandPalette.tsx` (lines 171–197): Render `Switch Harness` items as `disabled` with hint when `!canSwitchHarness` instead of hiding the group.
- `apps/web/src/features/chat/layouts/DesktopShell.tsx`, `CompactShell.tsx`, and `WorkspacePage.tsx`: Optionally promote/mirror the Harness Switcher `<select>` / menu into the session header alongside `HarnessBadge`.

## 5. Test / Verification Plan
- Playwright E2E Group 5 (`group5-cross-harness-sync.ts`):
  - Verify Harness Switcher is accessible from the header (or clearly discoverable on both `1440x900` and `390x844`).
  - Send `[SLOW]`, assert the Harness Switcher is disabled with an explanatory `title` attribute, and open `Ctrl+K` to verify `"Switch harness to ..."` items remain visible in a disabled state with a busy hint.
