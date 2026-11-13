# Issue: Agent profile input placeholder is clipped to "Optional --ag"

## 1. Problem Statement / Reproduction
- **Group**: Group 2 (New Session Composer, Harness Picker, Context Controls, Slash/File Autocomplete & Image Upload)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-hard-to-use`
- **Steps to Reproduce**:
  1. Open Harness Web on Desktop (`1440x900`) or Mobile (`390x844`) with the New Session composer visible.
  2. Look at the `Agent` input field in the composer control row (`ChatPanel.tsx`).
- **Actual Result**:
  - The input width (`w-32`, `126px` inner clientWidth / `110px` content width) is much narrower than the monospace placeholder `"Optional --agent profile"` (`173px` measured width).
  - Visually, the placeholder is cut off mid-word as `"Optional --ag"` (screenshots: `/tmp/e2e-harness-full/artifacts/group2-composer-controls/01-agy-new-session.png`, `02-opencode-new-session.png`, `06-mobile-composer.png`).
  - Additionally, `"--agent"` exposes a CLI flag convention that does not match OpenCode's server API `agent` field (`build`, `plan`).
- **Expected Result**:
  - The placeholder text is completely readable without horizontal clipping on both desktop and mobile, and uses harness-agnostic wording (e.g., `"Optional profile"` or wider input `w-44`/`min-w-[160px]`).

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/ChatPanel.tsx` line 603 hardcodes `className="w-32 rounded ... font-mono text-xs ..."`.
- `apps/web/src/lib/i18n/locales/en.ts` line 37 sets `agentProfilePlaceholder: "Optional --agent profile"`, which renders at `~173px` in `font-mono text-xs`, exceeding the `110px` content width inside `w-32` (`128px` minus `px-2` padding and borders).

## 3. Proposed Fix(es)
### Option 1: Shorten `agentProfilePlaceholder` copy in `en.ts`
- Pros: One-line change; fits cleanly inside `w-32` (`"Optional profile"` or `"Optional"` is well under `110px`); removes CLI flag jargon (`--agent`) that doesn't apply to OpenCode.
- Cons: Long profile names typed by user still sit in a `128px` box.

### Option 2: Widen the input in `ChatPanel.tsx` (`w-44` or `min-w-[180px]`)
- Pros: Keeps full `"Optional --agent profile"` visible.
- Cons: Takes more horizontal space in the composer row on desktop and still leaks `--agent` CLI syntax for OpenCode.

### Option 3: Shorten placeholder to `"Optional profile"` AND slightly widen input (`w-36` / `sm:w-40`)
- Pros: Clean, harness-agnostic label that never clips even across font variations, plus extra room for typed profile names like `architect` or `reviewer`.
- Cons: Minor 16–32px width increase in the wrap-enabled control bar.

### Recommended: Option 3
- Update `en.ts:37` `agentProfilePlaceholder` to `"Optional profile"` and widen `ChatPanel.tsx:603` from `w-32` to `w-36`.

## 4. File-Level Change Plan
- `apps/web/src/lib/i18n/locales/en.ts` (line 37): Change `agentProfilePlaceholder` to `"Optional profile"`.
- `apps/web/src/features/chat/components/ChatPanel.tsx` (line 603): Change `w-32` to `w-36` on the `agentProfile` `<input>`.

## 5. Test / Verification Plan
- Run Playwright E2E `group2-composer-controls.ts` and assert `placeholderWidth <= contentWidth` for `getByLabel("Agent")` on both desktop (`1440x900`) and mobile (`390x844`).
- Visually verify screenshots `01-agy-new-session.png`, `02-opencode-new-session.png`, and `06-mobile-composer.png` show no clipped placeholder text.
