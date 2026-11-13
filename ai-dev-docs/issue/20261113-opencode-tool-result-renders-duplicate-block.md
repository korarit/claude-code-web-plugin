# Issue: OpenCode `tool_result` events render as a duplicate `ToolCallBlock` with duplicate file-edit pills

## 1. Problem Statement / Reproduction
- **Group**: Group 4 (OpenCode `opencode` Live Session Flow & Interactive Controls)
- **Harness**: `opencode` (and any adapter emitting `type: "tool", tool: "tool_result"` with matching `toolUseId`)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Start an `OpenCode` session and send `"[PERM]"`.
  2. Click **Allow Once** (or **Deny**) and inspect the tool call blocks inside the assistant message.
- **Actual Result**:
  - Two separate `ToolCallBlock` cards render for the single `edit` tool call:
    1. `edit` — `edit: /tmp/e2e-harness-full/git-repo/src/app.ts` with pill `Edited src/app.ts (+2 -1) · openai/gpt-4o`
    2. `tool_result` — `Edited src/app.ts` (or `Permission rejected`) with a **second identical** pill `Edited src/app.ts (+2 -1) · openai/gpt-4o`
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group4-opencode-session/02-perm-allow-error.png`, `/tmp/e2e-harness-full/artifacts/group4-part2-diag/diag-01-perm-deny.png`, `/tmp/e2e-harness-full/artifacts/group4-opencode-session/12-mobile-opencode.png`.
- **Expected Result**:
  - Only **one** `ToolCallBlock` (`edit`) renders per tool invocation; the `tool_result` updates/completes that existing `ToolBlock` (attaching output/status) rather than creating a second `tool_result` card with a duplicate diff pill.

## 2. Root Cause Hypothesis
- `apps/api/src/modules/harness/infrastructure/opencode-event.mapper.ts` lines 361–379 emits a separate `NormalizedHarnessEvent` with `type: "tool", tool: "tool_result", toolUseId: callId, text: outputText` when a tool part enters `completed` or `error`.
- `apps/web/src/features/chat/hooks/useChat.ts` lines 344–403 (`case "tool":`) creates a new `ToolBlock` (`id: event.toolUseId ?? event.id`) and appends it to `last.tools` whenever `!(existingTools.some((t) => t.id === block.id && t.summary === block.summary))` (line 375). Because `tool: "tool_result"` has a different `summary` (`"Edited src/app.ts"`) than the initial `"edit"` block (`"edit: /path/to/src/app.ts"`), it passes the check and appends a second `ToolBlock` with the **same `id` (`callId`)**.
- `apps/web/src/features/chat/components/ToolCallBlock.tsx` lines 25–28 matches `changesFiles` by `rev.toolUseId === block.id`, so both the `edit` block and the `tool_result` block match the same revision and render duplicate `Edited src/app.ts` pills.
- Additionally, `ToolCallBlock.tsx` line 6 `FILE_EDIT_TOOLS` only lists PascalCase Claude tool names (`"Edit"`, `"Write"`, `"MultiEdit"`, `"NotebookEdit"`), missing OpenCode's `"edit"` / `"write"` / `"patch"` and AGY's `"write_file"` / `"write_to_file"`.

## 3. Proposed Fix(es)
### Option 1: Merge `tool === "tool_result"` events into the existing `ToolBlock` by `toolUseId` in `useChat.ts` (and `useAgentStream.ts`)
- Pros: Cleanly displays 1 `ToolCallBlock` per tool invocation, optionally showing the result summary or status badge on that single block, and eliminates duplicate file-change pills across all harnesses (`opencode`, `claude`, `agy`).
- Cons: Needs to preserve `tool_result` output inside the existing `ToolBlock` (e.g., optional `resultSummary` / `status` field on `ToolBlock`) if desired in the expanded view.

### Option 2: Suppress `tool_result` events in `opencode-event.mapper.ts`
- Pros: Quick fix for OpenCode.
- Cons: Drops tool error/output text and wouldn't fix `tool_result` rendering for other harnesses or canonical replay.

### Recommended: Option 1 (+ expand `FILE_EDIT_TOOLS` in `ToolCallBlock.tsx`)
- Reason: Merging `tool_result` into the matching `ToolBlock` in `useChat.ts` (and `useAgentStream.ts`) solves the duplicate card/pill structurally for all harnesses while keeping tool result output inspectable.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 344–403): When `event.tool === "tool_result"` and `event.toolUseId` matches an existing `ToolBlock` in `messages`, update that `ToolBlock` (e.g., `resultText` / `status`) instead of appending a new `tool_result` block.
- `apps/web/src/features/chat/hooks/useAgentStream.ts`: Apply the same `tool_result` merge logic for subagent streams.
- `apps/web/src/features/chat/components/ToolCallBlock.tsx` (line 6): Add `"edit"`, `"write"`, `"patch"`, `"write_file"`, `"write_to_file"`, `"replace_file_content"` to `FILE_EDIT_TOOLS`, and optionally render `block.resultSummary` inside the expanded details.

## 5. Test / Verification Plan
- Run Playwright E2E Group 4 (`[PERM]` Allow Once):
  - Verify only **1** `edit` `ToolCallBlock` renders (no separate `tool_result` block) and only **1** `Edited src/app.ts` pill renders.
