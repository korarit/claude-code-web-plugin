# Feature: Multi-Harness Adapters (`Claude CLI`, `Antigravity CLI`, `OpenCode`)

> Date: 2026-11-13
> Roadmap Phase: Phase 5
> Status: Implemented & Verified

## Overview

Phase 5 introduces the `harness` bounded context and decouples `chat` session execution, streaming, interactive controls, file change attribution, subagent telemetry, and external session discovery behind unified ports (`HarnessAdapter` & `HarnessGatewayPort`). Users can start and resume sessions across **Claude CLI** (`claude`), **Antigravity CLI** (`agy`), and **OpenCode** (`opencode`), filter sessions by harness/origin/project, and handle permissions and questions through a single Web UI (`PendingInteraction`).

## Implemented Architecture

### 1. Shared Contracts (`packages/contracts`)
- `packages/contracts/src/harness.ts`: `HarnessId` (`"claude" | "agy" | "opencode"`), `HarnessCapabilities`, `HarnessDescriptor`, `HarnessesListResponse`, and `DiscoveredExternalSession`.
- `packages/contracts/src/chat.ts`: Widened `ModelId` to `string` (preserving `AVAILABLE_MODELS` defaults), imported `HarnessId` from `harness.ts`, and added optional `harnessId` to `ChatSendRequest`.

### 2. `harness` Bounded Context (`apps/api/src/modules/harness/`)
- **Domain (`domain/`)**:
  - `harness.port.ts`: `HarnessAdapter`, `NormalizedHarnessEvent`, `HarnessInputPayload`, `StartedHarnessSession`, `StartHarnessSessionOptions`.
  - `errors.ts`: `UnknownHarnessError`, `HarnessUnavailableError`, `HarnessSpawnError`, `OpenCodeServerError`.
- **Application (`application/`)**:
  - `harness-registry.ts`: Registers adapters, probes descriptors/models/agent profiles, and coordinates `discoverAll()` / `watchAll()` / `dispose()`.
  - `list-harnesses.usecase.ts`: Powers `GET /api/harnesses`.
- **Presentation (`presentation/`)**:
  - `harness.routes.ts`: Exposes `GET /api/harnesses`.
- **Infrastructure (`infrastructure/`)**:
  - `claude-harness.adapter.ts`: Wraps `TmuxRunner` and `JsonlTranscriptWatcher`, supports external `~/.claude/projects` discovery, agent profile discovery (`.claude/agents/*.md`), and TUI question injection.
  - `agy-harness.adapter.ts` + `agy-transcript.parser.ts`: Runs `agy` in `tmux` (`--conversation`, `--model`, `--agent`, `-e HARNESS_WAIT_PRETOOLUSE=1`), parses AGY JSONL transcripts (`USER_INPUT`, `PLANNER_RESPONSE`, `tool_calls`, `TOOL_RESULT`, `ERROR`), detects `invoke_subagent` (`conversation://<id>`) and `ask_question`, discovers external CLI transcripts (`~/.gemini/antigravity-cli/brain`) and optional IDE mirror transcripts (`~/.gemini/antigravity/brain`), inspects tail lines in `waitUntilReady()`, and handles blocking `PreToolUse` decisions.
  - `opencode-harness.adapter.ts` + `opencode-event.mapper.ts`: Manages `opencode serve` daemons (or attaches via `OPENCODE_SERVER_URL`), subscribes to `/global/event` SSE (`message.updated`, `message.part.updated`, `session.created`, `permission.asked`, `question.asked`), maps OpenCode `parentID` child sessions into subagents, replies to REST `/permission/:id/reply` and `/question/:id/reply`, discovers external sessions from OpenCode SQLite (`opencode.db`) + SSE without spawning servers for offline history rows, and falls back to querying `message`/`part` tables in SQLite when reading recent events offline.

### 3. Cross-Context Decoupling (`chat`, `changes`, `agents`, `plugins/web`)
- `apps/api/src/modules/chat/`: Routes send/resume/input/abort/observe/discovery via `HarnessGatewayPort` cleanly without harness-specific logic inside `chat` domain/application; `HandleHookUsecase` supports `X-Agy-Web-Session-Id`, `X-Harness-Id`, and `X-Harness-Wait-Decision: 1`; `InteractionCoordinator` only short-circuits to hook resolution when an active waiter exists so OpenCode SSE permission prompts forward to REST `/permission/:id/reply`.
- `apps/api/src/modules/changes/`: Tracks AGY (`write_file`, `edit_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `TargetFile`, `Path`) and OpenCode (`edit`, `write`, `patch`, `multiedit`, `filePath`) edits with per-harness and per-model attribution.
- `apps/api/src/modules/agents/`: Maps AGY `invoke_subagent` (`Role`, `TypeName`), OpenCode `parentID` child sessions, and AGY/OpenCode tool activity into `AgentNode` telemetry and subagent stream drill-down (including routing `.system_generated/logs/transcript.jsonl` subagent transcripts through `AntigravityHarnessAdapter`).
- `plugins/web/scripts/hook-forwarder.sh`: Supports `AGY_WEB_SESSION_ID` (`X-Agy-Web-Session-Id`, `X-Harness-Id: agy`) and `HARNESS_WAIT_PRETOOLUSE=1` for blocking `PreToolUse` prompts.

### 4. Frontend (`apps/web/src/features/chat/`)
- `api.ts` & `hooks/useHarnesses.ts`: Fetches `/api/harnesses` at `WorkspacePage` root and filters `GET /api/chat/sessions?harness=...`.
- `hooks/useChat.ts` & `hooks/useSessions.ts`: Tracks `harnessId`, falls back to the first `available` harness if the default is missing, auto-selects harness default model on new session switch, sends `harnessId` on `POST /api/chat/send`, and filters session lists by `harness`.
- `components/HarnessPicker.tsx` & `components/HarnessBadge.tsx`: Segmented harness picker for new sessions (disables missing CLIs with localized tooltip) and semantic accent badges (Claude amber, Antigravity indigo, OpenCode emerald) across `SessionSidebar`, `ChatPanel`, `DesktopShell`, and `CompactShell`.
- `components/ChatPanel.tsx` & `components/SessionSidebar.tsx`: Dynamic `/model <id>` slash commands built from the active harness's `modelOptions`, OpenCode running banner support without `tmuxSession`, and `opencode_server` origin filter option.
- `lib/i18n/locales/en.ts`: Added harness-neutral English UI labels for multi-harness controls, banners, and filters.

## Verification
- Integration & unit suite in `apps/api/test/phase5-multi-harness-adapters.test.ts` covering `GET /api/harnesses`, AGY tmux launch (`HARNESS_WAIT_PRETOOLUSE=1`) + blocking `PreToolUse` + E2E `hook-forwarder.sh` decision output + `TargetFile` extraction + subagent transcript drill-down + `ChangesDrawer` attribution, OpenCode SSE streaming + REST permission/question replies + `parentID` subagents + offline SQLite `message`/`part` history replay, and external discovery across Claude JSONL, AGY CLI + IDE mirror, and OpenCode SQLite with `?harness=` filters.
