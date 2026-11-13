# Issue: Mobile CompactShell header squeezes session/app title down to `"H..."`

> **Category:** `ux-confusing` / `bug` (Responsive Layout)  
> **Found In:** Group 1 — Boot, Health, Responsive Shell & Global Controls (`390x844` mobile viewport)  
> **Harnesses Affected:** All (`agy`, `opencode`, `claude`)

---

## 1. Problem Statement / Reproduction

1. Open the Web UI at `390x844` (mobile viewport) or resize desktop down below `1280px`.
2. Inspect the top header bar.

- **Actual behavior:** The right-side action cluster (`Search` icon, `+` New Session icon, `"Sound On"` text button, and 3-option `"System | Light | Dark"` segmented `ThemeSwitcher`) is `shrink-0` and consumes almost the entire `390px` width, squeezing the left title span down to ~`24.5px` so `"Harness Web"` renders as **`"H..."`** (and any active session title becomes a single illegible letter). Also `HarnessBadge` is hidden below `sm:` (`640px`), so mobile users cannot see which harness or session title they are viewing in the header.
- **Expected behavior:** Mobile users should clearly see the active session title (or app name) and harness badge without truncation to 1 letter.
- **Evidence:** Screenshot `/tmp/e2e-harness-full/artifacts/group1-boot-shell/06-mobile-chat.png` (`MOBILE_LAYOUT_AUDIT.titleWidth: 24.53125`).

---

## 2. Root Cause Hypothesis

- [CompactShell.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/layouts/CompactShell.tsx#L68-L116) renders full desktop-sized `<SoundToggle />` (icon + `"Sound On"` text) and `<ThemeSwitcher />` (3 full text buttons `"System"`, `"Light"`, `"Dark"`) inline inside the `h-12` single-row mobile header alongside `Search` and `+`, starving the `min-w-0` title container.

---

## 3. Proposed Fix(es)

- **Option 1 (Recommended):** Make `<SoundToggle compact />` icon-only and `<ThemeSwitcher compact />` a single cycling icon button (or compact dropdown) below `sm:`, or move Sound/Theme into the mobile drawer / Command Palette (`Cmd+K`) on `<640px` screens so the header has room for the session title and `<HarnessBadge compact />`.
- **Option 2:** Wrap the mobile header into two compact rows below `sm:`.
- **Option 3:** Keep only Menu, Title + HarnessBadge, Search/Commands, and New Session in the mobile header, and put Theme/Sound inside the Sidebar Drawer footer on mobile.

---

## 4. File-Level Change Plan

- `apps/web/src/features/chat/layouts/CompactShell.tsx`
- `apps/web/src/features/chat/components/SoundToggle.tsx`
- `apps/web/src/features/chat/components/ThemeSwitcher.tsx`

---

## 5. Test / Verification Plan

1. Open `/` and `/sessions/:id` at `390x844` in Playwright.
2. Assert the header title bounding box width is `>= 120px` and not truncated to 1–2 characters, and verify `<HarnessBadge />` is visible on an active session.
