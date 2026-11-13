# Issue: File change tracker races `onPreToolUse` snapshot with tool write, recording identical baseline and producing empty diff (`+0 -0`)

## 1. Problem Statement / Reproduction
- **Group**: Group 7 (Inspector Panels — Changes & Diff Viewer, Multi-Agent Board & Terminal Attach)
- **Harness**: `opencode` (and any fast local file write harness emitting SSE events)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. In an `opencode` session, trigger an edit on an existing repository file (e.g. `"[EDIT:src/app.ts]"`).
  2. The harness emits `tool: "write"` with status `running`, writes the file to disk, and emits status `completed`.
  3. When `apps/api` processes the events, `onPreToolUse` reads `currentBytes` from disk after the write has already landed.
  4. Open `Changes` inspector panel.
- **Actual Result**:
  - The file is listed with `+0 -0` additions and deletions (`src/app.ts opencode · openai/gpt-4o +0 -0`).
  - In `DiffViewer`, the diff pane shows: "No textual differences to display." even though the file on disk was modified and differs from git HEAD.
  - Screenshots / Logs: `/tmp/e2e-harness-full/artifacts/group7-inspector-panels/01-opencode-edit-completed.png`.
- **Expected Result**:
  - When a file has been modified on disk compared to git HEAD, the initial session baseline must reflect the pre-edit content (falling back to git HEAD if `onPreToolUse` captured the post-edit content).
  - Additions and deletions must accurately reflect modified lines (e.g. `+2 -1`), and the diff viewer should display unified diff hunks.

## 2. Root Cause Hypothesis
- In [apps/api/src/modules/changes/application/record-tool-change.usecase.ts](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/api/src/modules/changes/application/record-tool-change.usecase.ts#L111):
  ```ts
  const currentBytes = await this.files.readFileBytes(resolved.absPath);
  const baselineKey = `${input.sessionId}:${resolved.relPath}`;
  if (!this.repo.get(input.sessionId, resolved.relPath) && !this.pendingBaselines.has(baselineKey)) {
    this.pendingBaselines.set(baselineKey, { bytes: currentBytes });
  }
  ```
- If the tool wrote to disk before or concurrently with `onPreToolUse` executing, `currentBytes` is already the new edited content.
- Later in `onPostToolUse` (lines 232–245):
  ```ts
  const rawBaseline = pendingBaseline ? pendingBaseline.bytes : (preBytes ?? null);
  baselineBytes =
    bytesEqual(rawBaseline, afterBytes) && preBytes && !bytesEqual(preBytes, afterBytes)
      ? preBytes
      : rawBaseline;
  ```
- Because `rawBaseline` was captured after the edit, `bytesEqual(rawBaseline, afterBytes)` is `true`.
- Furthermore, `preBytes` is also equal to `afterBytes`. The fallback in line 218 (`preBytes = await this.git.readHeadFile(...)`) only executes if `preBytes === undefined`, NOT when `bytesEqual(preBytes, afterBytes)` is true for a non-edit tool without `reconstructEditBefore` input.
- Consequently, `baselineBytes` is saved as `afterBytes`. When `computeLineStats(baselineBytes, afterBytes)` runs, additions and deletions are both 0 (`+0 -0`).
- When `GetFileDiffUsecase` runs, `originalBytes` and `modifiedBytes` are identical, producing an empty unified diff ("No textual differences to display.").

## 3. Proposed Fix(es)
### Option 1: Fall back to Git HEAD baseline when `rawBaseline` equals `afterBytes` for tracked repository files
- In `onPostToolUse`:
  ```ts
  if (bytesEqual(baselineBytes, afterBytes)) {
    const gitHead = await this.git.readHeadFile(input.cwd, resolved.relPath).catch(() => null);
    if (gitHead && !bytesEqual(gitHead, afterBytes)) {
      baselineBytes = gitHead;
      baselineMissing = false;
      baselineKey = `baseline-${newRevisionId()}`;
      await this.snapshots.saveSnapshot(input.sessionId, baselineKey, baselineBytes);
    }
  }
  ```
- Pros: Robust against any race condition where tool execution outpaces event ingestion; guarantees meaningful diffs against git HEAD for initial edits in repository sessions.
- Cons: None; only activates if baseline would otherwise be identical to the modified file.

### Option 2: Rely solely on git diff
- Pros: Simple.
- Cons: Loses session-scoped baseline isolation for untracked intermediate revisions.

### Recommended: Option 1
- Fall back to `this.git.readHeadFile` whenever the computed baseline is identical to `afterBytes`.

## 4. File-Level Change Plan
- [record-tool-change.usecase.ts](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/api/src/modules/changes/application/record-tool-change.usecase.ts):
  - In `onPostToolUse` lines 233–245: after computing `baselineBytes`, check if `bytesEqual(baselineBytes, afterBytes)`. If so, attempt `await this.git.readHeadFile(input.cwd, resolved.relPath)`. If git HEAD exists and differs from `afterBytes`, use it as `baselineBytes`.
  - Also ensure `preBytes` falls back to `git.readHeadFile` when `bytesEqual(preBytes, afterBytes)`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 7 (`group7-inspector-panels.ts`):
  - Send `[EDIT:src/app.ts]` in OpenCode without synthetic delays.
  - Verify `Changes (1)` badge updates, file list shows additions and deletions `> 0`, and `DiffViewer` renders green/red diff rows.
