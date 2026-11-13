# Issue: `harness_switched` divider says `"synced turns #X–#Y"` while footer simultaneously displays `"Pending sync · #X–#Y"`

## 1. Problem Statement / Reproduction
- **Group**: Group 5 (Cross-Harness Switching & Canonical Sync `agy` ⇄ `opencode`)
- **Harness**: All (`claude`, `agy`, `opencode`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Start a session on `OpenCode` (or `Antigravity`) and complete 1 turn (`seq #1–#2`).
  2. Switch harness to `Antigravity` (or `OpenCode`).
  3. Inspect both the chat timeline divider and the composer footer badges immediately after switching, before sending the next prompt.
- **Actual Result**:
  - The timeline divider renders: `Switched: OpenCode → Antigravity · synced turns #1–#2` (past tense: **"synced turns"**).
  - At the exact same time, the amber badge in the footer renders: `Pending sync · #1–#2` with no tooltip or explanation of how lazy delta sync works (screenshots: `/tmp/e2e-harness-full/artifacts/group5-cross-harness-sync/02-dir1-switched-to-agy.png`, `10-dir2-switched-to-opencode.png`).
  - Additionally, while `switchingHarness` is in flight (`ChatPanel.tsx` line 634), the `<select>` displays `"Switching..."` inside the *previous* harness `<option>` rather than the target harness.
- **Expected Result**:
  - Copy across the timeline divider and footer sync badge should be consistent and self-explanatory: before the first prompt on the new harness is sent, the divider/badge should clearly communicate that turns `#1–#2` are *queued / will sync on next message* (or distinguish queued vs delivered), and the `Pending sync` badge should include a helpful `title` tooltip explaining lazy verbatim sync.

## 2. Root Cause Hypothesis
- `apps/web/src/lib/i18n/locales/en.ts` lines 208–213:
  - Line 213 defines `harnessSwitchedWithRange: "Switched: {{from}} → {{to}} · synced turns #{{fromSeq}}–#{{toSeq}}"`, which uses past-tense `"synced turns"` even though `SwitchHarnessUsecase` uses lazy sync on next prompt send.
  - Lines 208–209 define `syncStatusPending: "Pending sync · {{count}} turns"` and `syncStatusPendingRange: "Pending sync · #{{from}}–#{{to}}"`.
- `apps/web/src/features/chat/components/ChatPanel.tsx`:
  - Lines 383–390 render `harnessSwitchedWithRange` immediately when `harness_switched` arrives.
  - Lines 665–676 render the amber `Pending sync · #{{from}}–#{{to}}` `<Badge>` with no `title` tooltip explaining that queued turns will be injected on the next prompt.
  - Line 634 checks `switchingHarness && h.id === activeSession.harnessId` to display `t("switchingHarness")`, replacing the *current* harness label instead of showing a dedicated switching indicator or target harness.

## 3. Proposed Fix(es)
### Option 1: Clarify i18n copy and add descriptive tooltip on `Pending sync` badge
- Update `harnessSwitchedWithRange` to `"Switched: {{from}} → {{to}} · context #{{fromSeq}}–#{{toSeq}}"` (or `"will sync turns #{{fromSeq}}–#{{toSeq}}"` / `"queued #{{fromSeq}}–#{{toSeq}}"`).
- Add a `title` tooltip on the `Pending sync` badge (e.g., `"Turns #{{from}}–#{{to}} will be injected into {{harness}} on your next message."`) and clarify badge copy (`"Sync on next send · #{{from}}–#{{to}}"` or `"Pending sync · #{{from}}–#{{to}}"` with tooltip).
- Show a crisp inline `"Switching..."` indicator beside the selector instead of mutating the current `<option>` text.
- Pros: Low-risk, eliminates contradictory past-tense vs pending wording immediately.
- Cons: Slight wording change in `en.ts` (update any unit/E2E text assertions accordingly).

### Option 2: Keep `harnessSwitchedWithRange` as-is and change footer badge to `"Context ready · #1–#2"`
- Pros: Avoids "Pending" alarm color (amber) for a normal lazy-sync state.
- Cons: Less obvious that the new harness hasn't received the context yet until a message is sent.

### Recommended: Option 1
- Reason: Making the divider neutral/future-oriented (`queued turns #1–#2` or `context #1–#2`) and giving the `Pending sync` badge a clear tooltip eliminates the direct contradiction ("synced" vs "Pending sync") while preserving visibility into lazy sync state.

## 4. File-Level Change Plan
- `apps/web/src/lib/i18n/locales/en.ts` (lines 206–213):
  - Clarify `harnessSwitchedWithRange` and add a `syncPendingTooltip` key.
- `apps/web/src/features/chat/components/ChatPanel.tsx` (lines 380–399, 629–684):
  - Add `title={t("syncPendingTooltip", ...)}` to the pending sync `<Badge>`.
  - Render an external `"Switching..."` indicator when `switchingHarness` is true instead of replacing the current `<option>` label.

## 5. Test / Verification Plan
- Playwright E2E Group 5 (`group5-cross-harness-sync.ts`):
  - Switch `OpenCode` → `Antigravity` after 1 turn, verify divider and footer badge wording are consistent (no contradictory `"synced"` + `"Pending sync"`), and verify `title` tooltip is present on the pending badge.
  - Send a follow-up prompt and verify the badge transitions cleanly to `Synced`.
