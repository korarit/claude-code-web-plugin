# Issue: Sidebar row actions (`Rename`, `Archive`, `Delete permanently`) are invisible on desktop unless hovered and lack `focus-within` visibility

## 1. Problem Statement / Reproduction
- **Group**: Group 6 (Session Sidebar, External Discovery & Session Lifecycle)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-hard-to-use`
- **Steps to Reproduce**:
  1. Open Harness Web on desktop (`1440x900`) with at least one session in `ACTIVE SESSIONS`.
  2. Inspect the sidebar without hovering over a row, OR navigate through the sidebar using `Tab` (keyboard-only navigation).
  3. Compare with the mobile drawer (`390x844`) where `Rename`, `Archive`, and `Delete permanently` are always visible on every card.
- **Actual Result**:
  - On desktop (`>= 1280px`), `Rename`, `Archive`, and `Delete permanently` have `opacity-100 xl:opacity-0 xl:group-hover:opacity-100` (`SessionSidebar.tsx` line 257).
  - Keyboard-only users tabbing into a row's `Rename` / `Archive` / `Delete permanently` button cannot see the focused button until they move a mouse pointer over the row because `xl:group-focus-within:opacity-100` is missing.
  - First-time desktop users (and touch-enabled 1280px+ laptops/tablets) have no visual cue (`⋮` menu or subtle icon) that session rows can be archived or permanently deleted unless they happen to hover over a row. (Meanwhile on mobile, always rendering 3 full text buttons per card adds ~28px height to every row, limiting visible sessions in `09-mobile-drawer.png`.)
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group6-sidebar-discovery/01-initial-desktop.png`, `09-mobile-drawer.png`.
- **Expected Result**:
  - Row actions remain visible whenever a row or any of its action buttons receives keyboard focus (`xl:group-focus-within:opacity-100`), and users have a clear, discoverable affordance (e.g., compact always-visible `⋮` action menu or `group-focus-within:opacity-100` + active row visibility) on both keyboard and touch devices.

## 2. Root Cause Hypothesis
- `apps/web/src/features/chat/components/SessionSidebar.tsx` line 257:
  ```tsx
  <div className="mt-1.5 flex items-center justify-end gap-1 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
  ```
  - Missing `xl:group-focus-within:opacity-100` (and active-row visibility or a compact always-visible trigger).

## 3. Proposed Fix(es)
### Option 1: Add `xl:group-focus-within:opacity-100` and keep actions visible on the currently selected row (`selected ? "opacity-100" : ...`)
- Pros: Zero layout change, immediately fixes keyboard focus visibility and gives active-row discoverability on desktop.
- Cons: Unselected rows still hide actions on touch laptops unless focused/hovered.

### Option 2: Replace the 3 inline text buttons with a compact `⋮` dropdown/popover menu (or icon buttons) that is always visible on the right of each row
- Pros: Always discoverable on mouse, touch, and keyboard; prevents accidental clicks on `Delete permanently` and saves vertical space on mobile (`390x844`).
- Cons: Adds one extra click for Rename/Archive/Delete.

### Recommended: Option 1 (immediate fix) or Option 2 (cleaner long-term mobile & desktop UX)
- Reason: Adding `xl:group-focus-within:opacity-100` (and showing actions for `selected` rows) immediately resolves the keyboard accessibility/visibility gap without changing workflows, while consolidating into a `⋮` menu can be considered if mobile card density grows.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/components/SessionSidebar.tsx` (line 257):
  - Update the action bar classes to include `xl:group-focus-within:opacity-100` (and optionally `selected ? "opacity-100" : "opacity-100 xl:opacity-0 xl:group-hover:opacity-100 xl:group-focus-within:opacity-100"`).

## 5. Test / Verification Plan
- On desktop (`1440x900`), press `Tab` to focus `Rename`, `Archive`, and `Delete permanently` inside a non-hovered sidebar row and assert computed `opacity === "1"` and visible bounding box.
- On mobile (`390x844`), verify row actions remain cleanly usable inside the drawer without horizontal overflow.
