# Phase 0: Monorepo Foundation & V1 Spike (`claude -p`)

> **Status:** ✅ Done  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Feature Doc:** [20261103-claude-web-ui.md](../feature/20261103-claude-web-ui.md)  
> **Architecture Spec:** [code-structure.md](../code-structure.md)

## 1. Objective

วางโครงสร้าง Monorepo ตาม DDD Modular Monolith + Shared Kernel และสร้าง V1 vertical slice ที่ใช้งานได้จริงบน port เดียว (Elysia API + React static build + Claude Code plugin shim `/web-start`)

## 2. Completed Deliverables

### 2.1 Monorepo & Shared Packages (`15db5c7`)
- `package.json` (Bun workspaces: `apps/*`, `packages/*`) และ `tsconfig.base.json` (`@core/*`, `@contracts/*`)
- `packages/core/src/`: `result.ts`, `errors.ts`, `ids.ts`, `time.ts`, `types.ts`, `utils.ts` (zero-dep pure TypeScript)
- `packages/contracts/src/`: `http.ts` (`okResponse`, envelope types), `chat.ts` (`ModelId`, `ChatSendRequest`, `SessionInfo`, `ChatStreamEvent`) — ปรับเป็น pure TS types เพื่อไม่ให้ FE ดึง Elysia เข้า bundle

### 2.2 Backend `apps/api` (`75409f6`)
- `src/env.ts` (`--port` / `PORT`, default `3000`), `src/plugins.ts` (error mapping), `src/index.ts` (serve `/api/*` + static `apps/web/dist`)
- `src/modules/chat/` แยกครบ 4 layers:
  - `domain/`: `session.entity.ts`, `chat.events.ts`, `repository.port.ts`, `errors.ts`
  - `application/`: `ports.ts` (`RunnerPort`), `send-message.usecase.ts`
  - `infrastructure/`: `claude-runner.ts` (`BunClaudeRunner` เรียก `claude -p --output-format stream-json`), `session.repository.ts` (`InMemorySessionRepository`)
  - `presentation/`: `chat.routes.ts` (`/api/health`, `/api/models`, `/api/chat/sessions`, `POST /api/chat/send`)

### 2.3 Frontend `apps/web` (`bcf3dbe`)
- Vite + React + Tailwind CSS v4
- `src/features/chat/`: `api.ts`, `hooks/useChat.ts`, `components/ChatView.tsx`, `components/ContextBar.tsx`, `components/TaskTimeline.tsx`

### 2.4 Claude Code Plugin Shim (`a1d28e6`)
- `plugins/web/.claude-plugin/plugin.json`
- `plugins/web/commands/web-start.md` (`/web-start --port <n>`)
- `plugins/web/scripts/start-web.sh`

## 3. Lessons Learned & Transition Reason

- การเรียก `claude -p` (headless mode) spawn process ใหม่ทุก turn ทำให้:
  1. มีความเสี่ยงด้าน ToS / anti-abuse detection เมื่อใช้ผ่าน consumer subscription OAuth
  2. ไม่สามารถตอบ permission prompt หรือ `AskUserQuestion` แบบ interactive กลางทางได้ (deny-by-default)
  3. ไม่เห็น session ที่ผู้ใช้เปิดทำงานเองใน terminal
- จึงเก็บ Phase 0 ไว้เป็นฐานโครงสร้าง Monorepo + DDD แล้วเปลี่ยน runner/observation layer ใน [Phase 1](./phase-01-interactive-tmux-jsonl-hooks.md)
