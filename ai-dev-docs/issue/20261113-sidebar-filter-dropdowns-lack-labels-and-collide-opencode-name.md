# Issue: Sidebar filter dropdowns lack accessible labels and collide on `"OpenCode"` between Harness and Source filters/badges

## 1. Problem Statement / Reproduction
- **Group**: Group 6 (Session Sidebar, External Discovery & Session Lifecycle)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Open Harness Web on desktop (`1440x900`) or open the mobile Sessions drawer (`390x844`).
  2. Inspect the two side-by-side filter dropdowns (`All Harnesses` and `All Sources`) and the `All Projects` dropdown below the search input.
  3. Open the `All Sources` dropdown and observe its last option, or inspect an `opencode_server`-originated session card in the sidebar.
- **Actual Result**:
  - In `SessionSidebar.tsx`, only the Harness `<select>` has an `aria-label` (`aria-label={t("harnessLabel")}`). Both the Source/Origin `<select>` (line 351) and Project `<select>` (line 367) have **no `aria-label`** and no visible label, leaving screen readers (and accessibility tools) with unlabeled `<select>` controls.
  - Inside the Source/Origin `<select>`, the option `value="opencode_server"` renders as `"OpenCode"` (`en.ts:17`: `originOpencode: "OpenCode"`) — identical to the Harness `<select>`'s `"OpenCode"` option (`en.ts:202`: `harnessOpencode: "OpenCode"`).
  - Worse, any session with `origin: "opencode_server"` displays two adjacent pills reading `[● OpenCode] [OpenCode]` (Harness badge + Origin badge), as visible in screenshots `06-new-opencode-web-session.png` and `09-mobile-drawer.png` (`OpenCode E2E Session` card).
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group6-sidebar-discovery/01-initial-desktop.png`, `06-new-opencode-web-session.png`, `09-mobile-drawer.png`.
- **Expected Result**:
  - Every filter `<select>` has a clear `aria-label` (e.g., `"Source"` / `"Project"`).
  - The `opencode_server` origin label clearly distinguishes the source from the harness name (e.g., `"OpenCode Server"` or `"Server"`), so users do not see `[● OpenCode] [OpenCode]` or identical `"OpenCode"` options in two adjacent dropdowns.

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/SessionSidebar.tsx`:
  - Lines 337–350 set `aria-label={t("harnessLabel")}` on the harness `<select>`, while lines 351–364 (origin `<select>`) and lines 367–378 (project `<select>`) omit `aria-label`.
- `apps/web/src/lib/i18n/locales/en.ts`:
  - Line 17 defines `originOpencode: "OpenCode"`, colliding verbatim with line 202 `harnessOpencode: "OpenCode"`.

## 3. Proposed Fix(es)
### Option 1: Add `aria-label` to Origin and Project selects and rename `originOpencode` to `"OpenCode Server"`
- Add `sourceFilterLabel: "Source"` and `projectFilterLabel: "Project"` (or reuse `cwdLabel`) to `en.ts` and attach `aria-label` to both `<select>` elements in `SessionSidebar.tsx`.
- Change `originOpencode` in `en.ts` from `"OpenCode"` to `"OpenCode Server"`.
- Pros: Immediately disambiguates Harness vs Source in both the filter dropdown and session row badges, and fixes accessibility for all 3 sidebar filters.
- Cons: Slightly wider badge on `opencode_server` rows (still fits comfortably in `flex-wrap`).

### Option 2: Use `"Server"` for `originOpencode`
- Pros: Shorter badge text.
- Cons: Less explicit if other harnesses gain server origins later; `"OpenCode Server"` is unambiguous.

### Recommended: Option 1
- Reason: `"OpenCode Server"` is self-explanatory next to `[● OpenCode]`, and adding `aria-label` makes all sidebar filter controls accessible.

## 4. File-Level Change Plan
- `apps/web/src/lib/i18n/locales/en.ts` (lines 17, 33): Change `originOpencode: "OpenCode Server"` and add `sourceFilterLabel: "Source"`.
- `apps/web/src/features/chat/components/SessionSidebar.tsx` (lines 351–378): Add `aria-label={t("sourceFilterLabel")}` on the origin `<select>` and `aria-label={t("cwdLabel")}` on the project `<select>`.

## 5. Test / Verification Plan
- Open Harness Web on desktop and mobile (`390x844`):
  - Verify `getByLabel("Harness")`, `getByLabel("Source")`, and `getByLabel("Project")` all resolve uniquely.
  - Verify the Source dropdown shows `OpenCode Server` instead of duplicating `OpenCode`, and `opencode_server` cards show `[● OpenCode] [OpenCode Server]` without clipping on `390px` width.
