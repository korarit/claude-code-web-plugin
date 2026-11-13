# Issue: Empty chat card instructs users to "Select a harness above" when controls are at the bottom

## 1. Problem Statement / Reproduction
- **Group**: Group 1 (Boot, Health, Responsive Shell & Global Controls)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Open Harness Web on desktop (`1440x900`) or mobile (`390x844`) with no active session selected (or click `+ New Session`).
  2. Read the empty state card in the center of `ChatPanel`: `"Start an interactive AI session — Select a harness above, pick a project directory, and send a prompt to begin streaming live updates."`
- **Actual Result**:
  - The card directs users to look **"above"** for the harness selector, while `HarnessPicker` (`Claude`, `Antigravity`, `OpenCode`) and the `Project` (`cwd`) field are actually rendered **below** the message area inside the bottom `<footer>` composer bar (screenshot: `/tmp/e2e-harness-full/artifacts/group1-boot-shell/01-desktop-initial.png`).
- **Expected Result**:
  - The instructional copy accurately points users to the composer controls **below** (e.g., `"Select a harness and project directory below, then send a prompt to begin streaming live updates."`).

## 2. Root Cause Hypothesis
- `apps/web/src/lib/i18n/locales/en.ts` line 53 defines:
  `emptyChatSubtitle: "Select a harness above, pick a project directory, and send a prompt to begin streaming live updates."`
- `apps/web/src/features/chat/components/ChatPanel.tsx` renders this card at lines 369-375 inside the scrollable message area, while `HarnessPicker` (lines 520-526) and the project `cwd` input (lines 563-579) are rendered inside the bottom `<footer>` composer (line 461).

## 3. Proposed Fix(es)
### Option 1: Update `emptyChatSubtitle` copy in `en.ts`
- Pros: One-line non-breaking copy fix; immediately accurate on both Desktop and Mobile layouts.
- Cons: None.

### Option 2: Move `HarnessPicker` into the top header of `ChatPanel`
- Pros: Would match "above".
- Cons: Adds another toolbar row at the top and duplicates/fragments the new-session setup controls (`Model`, `Auth`, `Project`, `Worktrees`, `Agent`) that already live together in the composer footer.

### Option 3: Render quick-pick harness/project pills directly inside the empty-state card
- Pros: Very discoverable onboarding when starting a new session.
- Cons: Duplicates controls already in the footer and requires state wiring/layout design.

### Recommended: Option 1
- Update `en.ts:53` from `"Select a harness above, pick a project directory..."` to `"Select a harness and project directory below, then send a prompt to begin streaming live updates."`

## 4. File-Level Change Plan
- `apps/web/src/lib/i18n/locales/en.ts` (line 53): Update `emptyChatSubtitle` text.

## 5. Test / Verification Plan
- Playwright E2E (`group1-boot-shell.ts`) / visual inspection on Desktop (`1440x900`) and Mobile (`390x844`) confirming the empty-state card text accurately says `"below"` and matches the position of `HarnessPicker` and `Project`.
