# 20261113 — Interactive Controls, External Session Discovery & Auth Modes (Phase 2)

> Plan Reference: [phase-02-interactive-controls-and-discovery.md](../plan/phase-02-interactive-controls-and-discovery.md)
> UI Concept: [ui-concept.md](../arc/ui-concept.md)
> Code Structure: [code-structure.md](../code-structure.md)
> Date (UTC): 2026-11-13

## 1. Goal / Background

Phase 1 established the `tmux` interactive TUI runner, incremental `.jsonl` transcript watcher, Claude Code hook forwarder, and Option 3 responsive web shell. However, Phase 1 could only send prompts and observe read-only status transitions.

Phase 2 upgrades the system to full interactive control and multi-source visibility:
1. Respond directly from the Web UI to Claude Code **permission prompts** (`Allow Once`, `Always Allow`, `Deny`) and **`AskUserQuestion` interactive option cards** (`single`/`multi-select` + custom text).
2. **Auto-discover and auto-save** sessions started outside the Web UI (external `cli` terminals, `tmux` panes, or historical `~/.claude/projects/**/*.jsonl` transcripts), distinguish `interactive` vs `mirror` control modes, and support **`Continue in Web`** (`--resume`).
3. Provide an **optional live Terminal drawer/tab** via `TerminalAttachPort` (defaulting to a zero-native-dependency WebSocket `tmux capture-pane` stream + key forwarding, swappable to native PTY later).
4. Support **Auth Mode isolation** (`machine_default` vs `api_key`) and **anti-ban safety guardrails** (concurrency soft-warning, running lock).
5. Support **multi-project `cwd` picker**, **`--agent` profile**, **mid-session `/model` & slash commands**, **`@file` workspace autocomplete**, **image paste upload**, and **Web Audio sound notifications** with mute toggle.

## 2. Scope (In / Out)

### In
- `packages/core` & `packages/contracts`: `PendingInteraction`, `ChatInputRequest`, `AuthMode`, `agentProfile`, `ResumeSessionRequest`, workspace file & image upload DTOs, terminal WebSocket message contracts.
- `apps/api`:
  - `InteractionCoordinator` (in-memory pending interaction hold + `PermissionRequest` HTTP long-poll resolver with timeout fallback).
  - `SendInputUsecase`, `ResumeSessionUsecase`, `DiscoverSessionUsecase`, `ListWorkspaceFilesUsecase`, `SaveUploadedImageUsecase`.
  - `HandleHookUsecase` updates: auto-discovery on external hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`), blocking `PermissionRequest` decision wait, clearing `PendingInteraction` on `PostToolUse` / `Stop`.
  - `TmuxRunner` updates: `--agent` flag, `ANTHROPIC_API_KEY` per-session env (only when `authMode === "api_key"` and server env has key), `capturePane()`, `sendKeysSequence()`.
  - `JsonlTranscriptWatcher` updates: detect `AskUserQuestion` `tool_use` blocks -> emit `interaction` event; detect matching `tool_result` -> emit `interaction_resolved` event.
  - `SessionDiscoveryService`: startup + periodic scan of `~/.claude/projects/**/*.jsonl` and `tmux list-panes` to auto-register and auto-save external sessions.
  - `TmuxCaptureTerminalAdapter` (`TerminalAttachPort`): WebSocket endpoint `/api/chat/sessions/:id/terminal` streaming `tmux capture-pane -e -p` updates and forwarding keys.
- `plugins/web/scripts/hook-forwarder.sh`: allow longer timeout for `PermissionRequest` hooks and echo returned hook decision JSON to stdout for Claude Code when the web server responds, while exiting `0` cleanly on timeout or offline server.
- `apps/web`:
  - `InteractionCard` (`PermissionBanner` + `QuestionCard`) pinned cleanly above the composer.
  - External `mirror` banner with **`Continue in Web`** button.
  - `TerminalPanel` (ANSI-safe monospace live view, accessory keys `[Tab] [Esc] [Ctrl+C] [↑] [↓] [↵]`, copy `tmux attach -t <name>`).
  - `DesktopShell` right/toggleable Terminal inspector + `CompactShell` Bottom View Bar (`Chat` | `Terminal`).
  - `AuthMode` badge & selector, concurrency warning banner, recent `cwd` selector, `agentProfile` input, `/model` & slash command menu, `@file` autocomplete, clipboard/file image paste upload, and Web Audio sound notifications + Mute toggle.

### Out
- Session code diff / git changes panel (`ChangesPanel`, Phase 3).
- Subagent worktree dashboard (`AgentBoard`, Phase 4).
- Antigravity / OpenCode harness adapters (Phase 5).
- Native C++ `node-pty` + `xterm.js` dependency (deferred behind `TerminalAttachPort`).

## 3. Proposed Approaches & Selected Design

Selected **Option 3** (Full Phase 2 with zero-native-dependency `TerminalAttachPort` adapter using WebSocket + `tmux capture-pane` ANSI stream & key forwarding).
- Blocking HTTP long-poll on `PermissionRequest` hooks avoids fragile key-scraping for permissions and gracefully falls back to Claude TUI if the web server is down or times out.
- `AskUserQuestion` combines full question/option parsing from `.jsonl` with `tmux capture-pane` verification and `tmux send-keys` navigation (`Up`/`Down`/`Space`/`Enter`/custom text), confirmed by `tool_result` / `PostToolUse`.
- `TerminalAttachPort` isolates WebSocket terminal transport in `infrastructure/` so a full PTY + `xterm.js` adapter can replace `capture-pane` later with zero domain or UI contract changes.

## 4. File-level Change Plan

```text
packages/core/src/ids.ts
packages/contracts/src/chat.ts
apps/api/src/modules/chat/
  domain/{session.entity.ts, chat.events.ts, repository.port.ts, errors.ts}
  application/{ports.ts, interaction-coordinator.ts, send-message.usecase.ts, handle-hook.usecase.ts, send-input.usecase.ts, resume-session.usecase.ts, discover-session.usecase.ts, workspace.usecases.ts, index.ts}
  infrastructure/{tmux-runner.ts, jsonl-watcher.ts, session.repository.ts, session-discovery.service.ts, terminal-attach.service.ts}
  presentation/chat.routes.ts
apps/api/src/index.ts
plugins/web/scripts/hook-forwarder.sh
apps/web/src/
  lib/{i18n/locales/en.ts, sound.ts}
  features/chat/{api.ts, hooks/useChat.ts, hooks/useSessions.ts, layouts/DesktopShell.tsx, layouts/CompactShell.tsx, components/InteractionCard.tsx, components/TerminalPanel.tsx, components/ChatPanel.tsx, components/WorkspacePage.tsx}
```

## 5. Test / Verification Plan

1. `bun run typecheck` and `bun run build` pass across all workspaces.
2. Unit tests:
   - `InteractionCoordinator` + `HandleHookUsecase` long-poll resolution and timeout fallback.
   - `JsonlTranscriptWatcher` parsing `AskUserQuestion` `tool_use` and `tool_result` resolution.
   - `SendInputUsecase` dispatching permission decisions and `AskUserQuestion` keystrokes.
   - `SessionDiscoveryService` deduplicating external CLI/`tmux` sessions and setting `mirror` vs `interactive`.
   - `TmuxRunner` `--agent`, `ANTHROPIC_API_KEY` env isolation, `capturePane`, and `sendKeysSequence`.
3. Integration / API smoke tests:
   - `POST /api/chat/hooks` (`PermissionRequest`) held until `POST /api/chat/input` resolves it and returns Claude hook decision JSON.
   - `POST /api/chat/sessions/:id/resume`, `GET /api/workspace/files`, `POST /api/chat/upload`, and `hook-forwarder.sh` decision passthrough & offline exit-0 safety.
