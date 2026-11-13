# Issue: Changes panel renders duplicate empty state messages vertically stacked when session has no file changes

## 1. Problem Statement / Reproduction
- **Group**: Group 7 (Inspector Panels — Changes & Diff Viewer, Multi-Agent Board & Terminal Attach)
- **Harness**: All harnesses (`claude`, `agy`, `opencode`)
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Open a new session or revert all changes in an existing session.
  2. Open the `Changes` inspector tab.
- **Actual Result**:
  - The inspector renders the exact same message ("No files edited in this session yet.") in two adjacent containers right on top of each other:
    1. In the top scrollable file list container: `<div class="px-2 py-3 text-center text-xs text-[var(--text-muted)]">No files edited in this session yet.</div>`
    2. Directly below in the main diff viewer area: `<div class="flex flex-1 items-center justify-center p-6 text-xs text-[var(--text-muted)]">No files edited in this session yet.</div>`
  - In addition to looking awkward and repetitive, automated tests and screen readers encounter strict-mode ambiguity with duplicate identical text elements.
  - Screenshots / Trace: `/tmp/e2e-harness-full/artifacts/group7-inspector-panels/03-opencode-revert-completed.png`.
- **Expected Result**:
  - A clean, unified empty state message should be displayed once in the panel body, or the file list should collapse/hide when empty while the main viewer displays the empty explanation.

## 2. Root Cause Hypothesis
- In [apps/web/src/features/chat/components/ChangesPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/ChangesPanel.tsx):
  - Line 199–203 (in the file list section):
    ```tsx
    ) : files.length === 0 ? (
      <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">
        {mode === "git" ? t("changesEmptyGit") : t("changesEmptySession")}
      </div>
    ) : (
    ```
  - And lines 336–340 (in the detail pane when `!selectedPath`):
    ```tsx
    ) : (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-[var(--text-muted)]">
        {mode === "git" ? t("changesEmptyGit") : t("changesEmptySession")}
      </div>
    )}
    ```
  - When `files.length === 0`, both branches render simultaneously, rendering `t("changesEmptySession")` twice in a single view.

## 3. Proposed Fix(es)
### Option 1: Render a single centered empty state when `files.length === 0`
- If `files.length === 0`, hide the file list header/scrollbar container completely and render a single centered empty state card in the panel body.
- When `files.length > 0` but `!selectedPath`, render a distinct message: `t("changesSelectFile")` ("Select a file to view diff.").
- Pros: Eliminates duplicate text, improves clarity and screen reader experience.
- Cons: Minor i18n key addition.

### Option 2: Hide the bottom empty message when `files.length === 0`
- In line 337, if `files.length === 0`, render `null` so only the top container shows the message.
- Pros: Quick one-line fix.
- Cons: Leaves the rest of the inspector area completely blank.

### Recommended: Option 1
- Differentiate between "no files changed in session" (single full-panel empty state) and "no file selected" (when files exist in the list but none is currently active).

## 4. File-Level Change Plan
- [ChangesPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/ChangesPanel.tsx):
  - If `files.length === 0`, render a single centered empty state covering the content area.
  - In the detail pane fallback (line 337), render `t("changesSelectFilePrompt")` ("Select a file above to view diff.") when `files.length > 0` but `selectedPath` is null.
- [apps/web/src/lib/i18n/locales/en.ts](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/lib/i18n/locales/en.ts):
  - Add `changesSelectFilePrompt: "Select a file to inspect differences"`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 7 (`group7-inspector-panels.ts`):
  - In a new session with 0 changes, verify `getByText("No files edited in this session yet.")` resolves to exactly 1 element.
  - When a file change is present but deselected, verify the detail pane prompts to select a file.
