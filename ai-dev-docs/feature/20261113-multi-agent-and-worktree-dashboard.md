# 20261113 — Multi-Agent Visibility & Worktree Dashboard (Phase 4)

> Plan Reference: [phase-04-multi-agent-and-worktree-dashboard.md](../plan/phase-04-multi-agent-and-worktree-dashboard.md)  
> Code Structure: [code-structure.md](../code-structure.md)  
> UI Concept: [ui-concept.md](../arc/ui-concept.md)  
> Date (UTC): 2026-11-13

## 1. Goal / Background

Phase 4 makes **Subagents** and **Claude Code Agent Teams** first-class visible entities in the Web UI, allowing users to inspect each agent's real-time activity state (`thinking`, `reading`, `editing`, `running_cmd`, `waiting`, `idle`, `done`), drill down into a subagent's live transcript stream and switch back to the main session without interrupting execution, monitor shared team/session tasks in real time, and isolate parallel work using **Git Worktrees** with per-worktree and per-agent diff review.

## 2. Scope

### In
- Shared contracts in `packages/contracts`:
  - `agents.ts`: `AgentNode`, `AgentActivityState`, `TeamTaskItem`, `TeamTaskStatus`, `SessionAgentsResponse`.
  - `workspace.ts`: `GitWorktreeInfo`, `ListWorktreesResponse`, `CreateWorktreeRequest/Response`, `MergeWorktreeRequest/Response`, `RemoveWorktreeRequest/Response`.
  - `chat.ts`: `ChatEventType` extended with `"agent_updated"` and `"tasks_updated"`.
- New backend bounded context `apps/api/src/modules/agents/` (`domain / application / infrastructure / presentation`):
  - Observe `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted` hooks + `.jsonl` `Task`/`Agent`/`TodoWrite`/`parent_tool_use_id` events + `~/.claude/tasks/<team-or-session>/` task files.
  - Tail subagent transcripts (`agent-{agentId}.jsonl`) in real time via `JsonlTranscriptWatcher`.
  - Endpoints: `GET /api/chat/sessions/:id/agents` and `GET /api/chat/sessions/:id/agents/:agentId/events` (SSE replay + live tail).
- New backend bounded context `apps/api/src/modules/workspace/` (`domain / application / infrastructure / presentation`):
  - `git worktree list --porcelain`, `git worktree add <path> -b <branch>`, safe merge helper, and worktree removal.
  - Endpoints: `GET /api/workspace/worktrees`, `POST /api/workspace/worktrees`, `POST /api/workspace/worktrees/merge`, `POST /api/workspace/worktrees/remove`.
- Plugin hook forwarding in `plugins/web/hooks/hooks.json` for `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`.
- Frontend (`apps/web`):
  - Single Resource Route `/sessions/:sessionId/agents/:agentId` and `← Back to Main` drill-down in `WorkspacePage.tsx` & `ChatPanel.tsx` (`Read-only Inspector` banner when `canSendInput === false`).
  - Root hooks `useAgents.ts` and `useWorktrees.ts` in `WorkspacePage.tsx` preserving live SSE streams across `1280px` viewport transitions.
  - Subagent tree with individual status spinners in `SessionSidebar.tsx`.
  - `AgentBoard.tsx` (agent cards with live state, current tool/target, token usage, mini-log, toggleable Visual Activity View, and real-time Kanban/Checklist Shared Task Board).
  - `WorktreeModal.tsx` for selecting/creating/merging/removing git worktrees and jumping into per-worktree / per-agent `ChangesPanel` diff review.
  - Updated `DesktopShell.tsx` (`Agents` top-bar toggle + inspector view) and `CompactShell.tsx` (`Agents` bottom tab).
  - English-only i18n keys in `apps/web/src/lib/i18n/locales/en.ts`.

### Out
- Multi-harness adapters (`Antigravity CLI`, `OpenCode`) — deferred to Phase 5.
- Cross-harness canonical session store & delta sync — deferred to Phase 6.
- Direct stdin injection into read-only Claude subagents when `canSendInput === false`.

## 3. Selected Approach — Option 2 (Dedicated `agents` + `workspace` Bounded Contexts)

1. **`agents` Bounded Context:** Keeps subagent/teammate state, subagent transcript tailing, and `~/.claude/tasks/` watching separate from `chat` lifecycle while communicating with `chat` through an `AgentTelemetryPort` wired in `apps/api/src/index.ts`.
2. **`workspace` Bounded Context:** Encapsulates git worktree discovery, creation, safe merging, and removal cleanly, while reusing Phase 3 `changes` endpoints on each session/worktree `cwd` and `agentId` attribution filter.
3. **Strict DDD Dependency Direction:** `domain/` layers in `agents` and `workspace` import only `@core/*` and relative domain files; `presentation/` layers import only `application/`, `@contracts/*`, and `@core/*`.

## 4. File-level Change Plan

- **Contracts:** `packages/contracts/src/{agents.ts,workspace.ts,chat.ts,index.ts}`
- **Plugin Hooks:** `plugins/web/hooks/hooks.json`
- **Backend `agents`:** `apps/api/src/modules/agents/{domain,application,infrastructure,presentation}/*`
- **Backend `workspace`:** `apps/api/src/modules/workspace/{domain,application,infrastructure,presentation}/*`
- **Backend Wiring & `chat` Bridge:** `apps/api/src/modules/chat/{domain/chat.events.ts,application/ports.ts,application/handle-hook.usecase.ts,application/transcript-sync.ts,application/delete-session.usecase.ts,infrastructure/jsonl-watcher.ts,presentation/chat.routes.ts}`, `apps/api/src/index.ts`
- **Frontend:** `apps/web/src/lib/i18n/locales/en.ts`, `apps/web/src/features/chat/{api.ts,hooks/useAgents.ts,hooks/useWorktrees.ts,components/AgentBoard.tsx,components/WorktreeModal.tsx,components/SessionSidebar.tsx,components/ChatPanel.tsx,components/ChangesPanel.tsx,components/WorkspacePage.tsx,layouts/DesktopShell.tsx,layouts/CompactShell.tsx}`
- **Tests & Docs:** `apps/api/test/phase4-multi-agent-and-worktree.test.ts`, `ai-dev-docs/plan/roadmap.md`, `ai-dev-docs/plan/phase-04-multi-agent-and-worktree-dashboard.md`

## 5. Test Plan

1. **Subagent Telemetry & Drill-down Stream (`apps/api/test/phase4-multi-agent-and-worktree.test.ts`):**
   - `SubagentStart` / `SubagentStop` hooks + `agent-{agentId}.jsonl` tailing update `AgentNode` states (`thinking` -> `reading` -> `editing` -> `done`), emit `agent_updated` on main session SSE, and stream full subagent replay + live events on `GET /api/chat/sessions/:id/agents/:agentId/events`.
   - `Task` / `TodoWrite` in `.jsonl` and `~/.claude/tasks/<session-or-team>/` JSON files + `TaskCreated` / `TaskCompleted` / `TeammateIdle` hooks sync `TeamTaskItem` (`pending -> in_progress -> completed`) and emit `tasks_updated`.
2. **Git Worktree Isolation & Per-Worktree Diff:**
   - Initialize temp git repo -> create 2 worktrees (`POST /api/workspace/worktrees`) -> list (`GET /api/workspace/worktrees`) -> run 2 sessions on separate worktree paths -> edit files independently -> verify `changes` diff per session/worktree is 100% isolated -> merge & remove worktree cleanly.
3. **Suite, Typecheck, Build, Boundary Check:**
   - `bun test apps/api/test`
   - `bun run typecheck`
   - `bun run build`
   - DDD import boundary verification on new `agents` and `workspace` modules.
