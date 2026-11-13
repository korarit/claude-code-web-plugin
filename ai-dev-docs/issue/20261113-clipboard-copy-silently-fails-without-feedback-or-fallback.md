# Issue: Copy buttons in inspector panels silently fail without user feedback or fallback when clipboard API is restricted

## 1. Problem Statement / Reproduction
- **Group**: Group 7 (Inspector Panels — Changes & Diff Viewer, Multi-Agent Board & Terminal Attach)
- **Harness**: All harnesses (`agy`, `claude`, `opencode`)
- **Category**: `ux-hard-to-use`
- **Steps to Reproduce**:
  1. Open the `Terminal` inspector tab for an active session.
  2. Click the `Copy tmux attach` button.
  3. Alternatively, in the `Changes` inspector tab, click `Copy path` or `Copy` in `DiffViewer`.
  4. Trigger this in any browser environment where `navigator.clipboard.writeText()` throws (e.g. document is not focused, iframe restrictions, or browser security policies).
- **Actual Result**:
  - The clipboard call throws (e.g. `NotAllowedError: Document is not focused` or `SecurityError`).
  - The error is silently swallowed in an empty `catch {}` block.
  - The button remains unchanged (`Copy tmux attach`), giving the user zero feedback on whether the copy succeeded, leaving them wondering why pasting doesn't work.
  - Screenshots / Trace: `/tmp/e2e-harness-full/artifacts/group7-inspector-panels/07-terminal-panel.png`.
- **Expected Result**:
  - If the modern asynchronous Clipboard API fails, the application should attempt a fallback (`document.execCommand('copy')`).
  - If copying still cannot be completed, the UI should provide visual feedback (e.g. tooltip or temporary toast: "Unable to copy to clipboard") instead of failing silently.

## 2. Root Cause Hypothesis
- In [apps/web/src/features/chat/components/TerminalPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/TerminalPanel.tsx#L97):
  ```tsx
  const copyAttachCmd = async () => {
    if (!activeSession?.tmuxSession) return;
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${activeSession.tmuxSession}`);
      setCopiedAttach(true);
      setTimeout(() => setCopiedAttach(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };
  ```
- The exact same pattern is repeated in:
  - [apps/web/src/features/chat/components/ChangesPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/ChangesPanel.tsx#L119) (`copyFilePath`)
  - [apps/web/src/features/chat/components/DiffViewer.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/DiffViewer.tsx#L151) (`handleCopyCode`)
- In all three components, clipboard errors are completely suppressed without any fallback or failure state indication.

## 3. Proposed Fix(es)
### Option 1: Create a shared `copyToClipboard` utility with `execCommand` fallback and failure feedback
- Implement `copyToClipboard(text: string): Promise<boolean>` in `apps/web/src/lib/clipboard.ts`:
  1. Try `navigator.clipboard?.writeText(text)`.
  2. If that fails or is unsupported, fallback to creating a hidden textarea and calling `document.execCommand("copy")`.
  3. Return `true` if either succeeded, `false` otherwise.
- In components, if it returns `false`, show a brief warning or toast indicating clipboard access was blocked.
- Pros: Reusable across the entire application (eliminating duplicated copy boilerplate); handles unfocused documents and non-secure origins gracefully.
- Cons: Minimal new utility file.

### Option 2: Add failure toast in catch blocks
- Pros: Simple.
- Cons: Does not attempt fallback copying.

### Recommended: Option 1
- Centralize clipboard copying with fallback in a single utility helper.

## 4. File-Level Change Plan
- `apps/web/src/lib/clipboard.ts`:
  - Export `copyToClipboard(text: string): Promise<boolean>`.
- [TerminalPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/TerminalPanel.tsx):
  - Use `copyToClipboard` in `copyAttachCmd`.
- [ChangesPanel.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/ChangesPanel.tsx):
  - Use `copyToClipboard` in `copyFilePath`.
- [DiffViewer.tsx](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/web/src/features/chat/components/DiffViewer.tsx):
  - Use `copyToClipboard` in `handleCopyCode`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 7 (`group7-inspector-panels.ts`):
  - Click `Copy tmux attach` -> verify `Copied!` feedback is displayed even in headless browsers.
