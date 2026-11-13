# Issue: OpenCode rejected permission (`status: "error"`) records a fake `Edited src/app.ts (+0 -0)` file change

## 1. Problem Statement / Reproduction
- **Group**: Group 4 (OpenCode `opencode` Live Session Flow & Interactive Controls)
- **Harness**: `opencode`
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Start a clean `OpenCode` session and send `"[PERM]"`.
  2. Click **Deny** on the `Permission Required: edit` `InteractionCard`.
  3. Observe the `Changes` badge in the top bar and the `Edited src/app.ts` pill on the tool block.
- **Actual Result**:
  - Even though permission was rejected and the assistant states `"Permission rejected; left src/app.ts untouched."`, the header shows `Changes (1)` and the tool block renders a green-dot pill `Edited src/app.ts (+0 -0) · openai/gpt-4o`.
  - Screenshot: `/tmp/e2e-harness-full/artifacts/group4-part2-diag/diag-01-perm-deny.png`.
- **Expected Result**:
  - When a file-edit tool fails or its permission is rejected (`state.status === "error"`), no file-change revision is recorded, `Changes` remains `(0)`, and no `Edited src/app.ts` pill is displayed.

## 2. Root Cause Hypothesis
- In `apps/api/src/modules/harness/infrastructure/opencode-event.mapper.ts` lines 361–379:
  - Both `status === "completed"` AND `status === "error"` emit the exact same event shape: `{ type: "tool", tool: "tool_result", toolUseId: callId, text: outputText }` without conveying `isError: true` or skipping `tool_result` file-change tracking.
- In `apps/api/src/modules/chat/application/transcript-sync.ts` lines 205–227:
  - `createObservedEventHandler` triggers `void fileChangeTracker.onPostToolUse(...)` for every `tool === "tool_result"` matching a `trackedTools` entry (`"edit"`), without checking whether the tool errored or whether the file actually changed.
- In `apps/api/src/modules/changes/application/record-tool-change.usecase.ts` lines 130–250:
  - `onPostToolUse` records a `TrackedFileRevision` even when `preBytes` equals `afterBytes` (`+0 -0` diff) if a revision for `toolUseId` didn't exist yet (and in `diag-01-perm-deny.png`, `src/app.ts` didn't even change!).

## 3. Proposed Fix(es)
### Option 1: Add `toolError?: boolean` (or `toolStatus?: "completed" | "error"`) to `NormalizedHarnessEvent` / `DomainChatEvent` and skip `fileChangeTracker.onPostToolUse` when `toolError` is true
- Pros: Accurately distinguishes failed/rejected tool calls from completed edits in both `transcript-sync.ts` and the UI (`ToolCallBlock` can also style errors in red instead of green).
- Cons: Requires adding an optional field to `NormalizedHarnessEvent` / `DomainChatEvent`.

### Option 2: In `RecordToolChangeUsecase.onPostToolUse`, skip recording a revision when `preBytes` and `afterBytes` are byte-identical (`+0 -0`)
- Pros: Prevents empty `(+0 -0)` no-op revisions regardless of harness or error state.
- Cons: Wouldn't distinguish failed tools in the chat UI if a file already had pre-existing changes or if we want an error badge on the `ToolCallBlock`.

### Recommended: Combine Option 1 & Option 2
- Reason: Propagating `toolError: true` skips `onPostToolUse` immediately on rejected/errored tools (and enables error styling in `ToolCallBlock`), while skipping byte-identical no-ops in `RecordToolChangeUsecase.onPostToolUse` acts as a defense-in-depth guard.

## 4. File-Level Change Plan
- `apps/api/src/modules/harness/domain/harness.port.ts` & `apps/api/src/modules/chat/domain/chat.events.ts`: Add optional `toolError?: boolean` to tool events.
- `apps/api/src/modules/harness/infrastructure/opencode-event.mapper.ts` (lines 361–379): Set `toolError: status === "error"` on emitted `tool_result` events.
- `apps/api/src/modules/chat/application/transcript-sync.ts` (lines 205–227): Skip `fileChangeTracker.onPostToolUse` (and clean up `trackedTools.delete(event.toolUseId)`) when `event.toolError` is true.
- `apps/api/src/modules/changes/application/record-tool-change.usecase.ts` (lines 191–250): Skip recording a revision when `preBytes` and `afterBytes` are identical (both missing or byte-equal).

## 5. Test / Verification Plan
- Run Playwright E2E Group 4 (`[PERM]` -> **Deny**):
  - Verify `Changes` stays `Changes (0)` and no `Edited src/app.ts (+0 -0)` pill appears on the denied tool call.
