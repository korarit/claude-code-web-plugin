# Issue: Auth mode dropdown (`Local CLI OAuth` / `ANTHROPIC_API_KEY`) is shown and confusing for Antigravity and OpenCode

## 1. Problem Statement / Reproduction
- **Group**: Group 2 (New Session Composer, Harness Picker, Context Controls, Slash/File Autocomplete & Image Upload)
- **Harness**: `agy`, `opencode`
- **Category**: `ux-confusing`
- **Steps to Reproduce**:
  1. Open Harness Web and select `Antigravity` or `OpenCode` in `HarnessPicker`.
  2. Inspect the `Auth` `<select>` control in the New Session composer footer (`ChatPanel.tsx`) and hover over it.
- **Actual Result**:
  - The `Auth` dropdown remains visible with options `Local CLI OAuth` and `API Key (Pay-as-you-go)` (disabled) and tooltip `"Set ANTHROPIC_API_KEY on the API server to enable API Key mode"`, even though neither Antigravity nor OpenCode uses `ANTHROPIC_API_KEY` or `authMode`.
  - If `ANTHROPIC_API_KEY` happens to be set on the server, a user on `Antigravity` or `OpenCode` can select `API Key (Pay-as-you-go)`, which is silently ignored by `AntigravityHarnessAdapter` and `OpenCodeHarnessAdapter`, yet the created session displays an `API Key (Pay-as-you-go)` badge.
  - Screenshots: `/tmp/e2e-harness-full/artifacts/group2-composer-controls/01-agy-new-session.png`, `02-opencode-new-session.png`.
- **Expected Result**:
  - The `Auth` mode selector (and Anthropic API Key option) is only shown for harnesses where `authMode` is supported (`claude`), or clearly replaced/hidden for `agy` and `opencode` so users are not misled about `ANTHROPIC_API_KEY` or billing mode.

## 2. Root Cause Hypothesis
- `apps/api/src/modules/chat/application/send-message.usecase.ts` lines 112 and 130 only enforce `ANTHROPIC_API_KEY` and OAuth concurrency warnings when `harnessId === "claude"`, and `apps/api/src/modules/chat/infrastructure/tmux-runner.ts` line 87 only injects `ANTHROPIC_API_KEY` for Claude sessions.
- `AntigravityHarnessAdapter` (`apps/api/src/modules/harness/infrastructure/agy-harness.adapter.ts`) and `OpenCodeHarnessAdapter` (`apps/api/src/modules/harness/infrastructure/opencode-harness.adapter.ts`) do not read `options.authMode` or `options.apiKey`.
- However, `apps/web/src/features/chat/components/ChatPanel.tsx` lines 547–561 unconditionally render the `Auth` `<select>` whenever `!activeSession`, and lines 686–688 unconditionally render the `authMode` badge for active sessions.

## 3. Proposed Fix(es)
### Option 1: Hide `Auth` selector and session `authMode` badge when `harnessId !== "claude"`
- Pros: Eliminates misleading UI and `ANTHROPIC_API_KEY` tooltip for `Antigravity` and `OpenCode`; also frees horizontal space in the composer bar (preventing `Project` input from squeezing/wrapping on desktop and reducing mobile composer height).
- Cons: Users switching from Claude to AGY won't see the Auth selector until they pick Claude again.

### Option 2: Add an explicit `supportsAuthMode` capability on `HarnessCapabilities` (`packages/contracts/src/harness.ts`)
- Pros: Clean DDD/contract-driven check; backend adapters declare capability and frontend renders `Auth` control only when `activeHarness?.capabilities.authMode` (or similar) is true.
- Cons: Slightly more boilerplate across contracts and adapter descriptors.

### Option 3: Keep `Auth` dropdown visible but disable it with a "Managed by <Harness>" label for non-Claude harnesses
- Pros: Preserves control position consistency.
- Cons: Wastes precious toolbar space (especially on mobile `390x844` where footer is already ~260px tall) for a non-actionable control.

### Recommended: Option 1 (or Option 2 if additional harnesses will support per-session auth modes)
- Render the `Auth` `<select>` in `ChatPanel.tsx:547-561` and the `authMode` badge in `ChatPanel.tsx:686-688` only when `effectiveHarnessId === "claude"` (or driven by a `HarnessCapabilities` flag), and reset/default `authMode` to `"machine_default"` for non-Claude harnesses in `useChat.ts`.

## 4. File-Level Change Plan
- `apps/web/src/features/chat/components/ChatPanel.tsx` (lines 547–561, 686–688): Conditionally render `Auth` `<select>` and session auth badge only when `effectiveHarnessId === "claude"`.
- `apps/web/src/features/chat/hooks/useChat.ts` (lines 535–546): Ensure `selectHarness` resets `authMode` to `"machine_default"` when switching to a non-Claude harness.

## 5. Test / Verification Plan
- Playwright E2E (`group2-composer-controls.ts`): Verify `Auth` selector is hidden when `Antigravity` or `OpenCode` is selected and visible when `Claude` is selected (when available), and verify no `ANTHROPIC_API_KEY` tooltip appears for `agy`/`opencode`.
