# 20261103 — Claude Web UI (Hybrid spawn, single-port FE+BE)

## 1. Goal / Background

- ต้องการ web UI แชทสั่งงานแทนการพิมพ์บน Claude CLI โดยตรง: พิมพ์ prompt บนเว็บ → backend spawn `claude -p --output-format stream-json` (reuse auth ของเครื่อง) → stream ผลกลับมาแบบ real-time
- ต้อง spawn web ได้ 2 ทาง (Hybrid): (a) ผ่าน Claude CLI ด้วย slash-command `/web-start --port <n>` (plugin `--plugin-dir`), (b) ตรงๆ ด้วย `bun run web -- --port <n>`
- FE (React) + BE (Elysia) ใช้ **port เดียวกัน**: Elysia เสิร์ฟ `/api/*` และ static `apps/web/dist` (fallback `index.html`)
- ความสามารถเว็บรุ่นแรก: แชทหลาย session (`--continue/--resume`), โชว์ context ที่ใช้ (จาก `system/init` + `result.usage`), สลับ model (`--model sonnet|opus|haiku`), แสดง task/sub-agent timeline (จาก event `parent_tool_use_id` + `TodoWrite`)

## 2. Scope (In / Out)

### In

- Monorepo scaffold ตาม `code-structure.md`: `package.json` workspaces, `tsconfig.base.json`, `packages/core`, `packages/contracts`, `apps/api`, `apps/web`
- `apps/api`: Elysia + module `chat` ครบ 4 layers (domain/application/infrastructure/presentation), `ClaudeRunner` spawn `claude -p … --output-format stream-json --verbose`, SSE `/api/chat/send`, `GET /api/chat/sessions`, `GET /api/models`, serve static FE, CLI parse `--port`/`PORT` (default 3000)
- `apps/web`: React chat UI (ส่งข้อความ/streaming, ContextBar, ModelPicker, TaskTimeline)
- `plugins/web`: Claude Code plugin shim (`.claude-plugin/plugin.json` + `commands/web-start.md` + `scripts/start-web.sh`) เรียก CLI ตัวเดียวกัน
- Design doc นี้ + commit แบบ incremental ตาม AGENT.md

### Out

- ยังไม่ทำ auth หลายผู้ใช้ / โควต้า / billing (ใช้เองคนเดียวบนเครื่องที่ `claude login` ไว้แล้ว — แชร์ subscription ให้คนอื่นผิด TOS, ดูคำอธิบายในแชท)
- ยังไม่ทำ DB ถาวร (session เก็บ in-memory + transcript `.jsonl` ของ CLI เอง), ยังไม่ทำ ORM
- ยังไม่ทำ CI/CD, Dockerfile, multi-workspace, MCP config UI, permission approve UI (deny-by-default ใน print mode)
- ยังไม่ scaffold shadcn เต็มชุด (ใช้ Tailwind v4 + CSS พื้นฐานไปก่อน แยก issue ทีหลัง)

## 3. Proposed Approach(es)

- **เลือกแล้ว: Option 3 Hybrid** (จาก 3 ตัวเลือกในแชท: plugin-only / standalone-only / hybrid)
- รันจริงอยู่ที่เดียว: `apps/api/src/index.ts` (Bun, Elysia) — รับ `--port` → `listen(port)` → เสิร์ฟ `/api/*` + static `../web/dist`
- Plugin `plugins/web` ไม่มี logic: `commands/web-start.md` แค่สั่ง `bun <repo>/apps/api/src/index.ts --port $ARG` (ผ่าน `scripts/start-web.sh`)
- แชท: FE `POST /api/chat/send {prompt, sessionId?, model?}` → BE ต่อ SSE, spawn `claude -p <prompt> [--resume id|--continue] [--model m] --output-format stream-json --verbose --include-partial-messages --forward-subagent-text`, parse NDJSON ทีละบรรทัด → forward เป็น SSE event (`init|delta|tool|task|result|error`)
- Context usage: เก็บ `context_window` (ถ้ามีใน `system/init`) + `usage {input_tokens, output_tokens}` จาก `result` → FE วาด progress bar
- Deviation จาก `code-structure.md` 1 จุด: `packages/contracts` เก็บ **pure TS types ล้วน** (ไม่ import `elysia`) เพื่อไม่ให้ FE ดึง server lib; Elysia `t.*` schema อยู่ใน `apps/api/.../presentation` แล้ว map กับ contract types

## 4. File-level Change Plan

```
package.json                      # workspaces apps/* packages/*, scripts: web/dev/build/typecheck
tsconfig.base.json                # strict + paths @core/* @contracts/*
.gitignore                        # node_modules, dist, *.log

packages/core/package.json + tsconfig.json
packages/core/src/{result,errors,ids,time,types,utils,index}.ts

packages/contracts/package.json + tsconfig.json
packages/contracts/src/{http,chat,index}.ts   # pure types, zero-dep (ยกเว้น @repo/core)

apps/api/package.json + tsconfig.json
apps/api/src/env.ts                                   # parse --port / PORT, default 3000
apps/api/src/plugins.ts                               # cors + AppError -> status map
apps/api/src/index.ts                                 # Elysia app, /api/*, static ../web/dist, listen
apps/api/src/modules/chat/domain/{session.entity,chat.events,repository.port,errors}.ts
apps/api/src/modules/chat/application/{ports,send-message.usecase,index}.ts
apps/api/src/modules/chat/infrastructure/{claude-runner,session.repository}.ts
apps/api/src/modules/chat/presentation/chat.routes.ts # SSE send + sessions + models

apps/web/package.json + tsconfig.json + vite.config.ts + index.html
apps/web/src/{main.tsx,App.tsx,styles.css}
apps/web/src/lib/api.ts
apps/web/src/features/chat/{api.ts,hooks/useChat.ts,components/ChatView.tsx,components/ContextBar.tsx,components/TaskTimeline.tsx}

plugins/web/.claude-plugin/plugin.json
plugins/web/commands/web-start.md
plugins/web/scripts/start-web.sh   # chmod +x, resolve repo root, exec bun api --port
```

## 5. Test Plan

1. **Typecheck:** `bun run typecheck` (tsc --noEmit ทุก workspace) ต้องผ่าน
2. **Build:** `bun run build` — `apps/web` (vite build → dist) + `apps/api` ต้องผ่าน; ตรวจ `apps/api` เสิร์ฟ `dist/index.html` ได้
3. **Smoke (single-port):** `PORT=4021 bun apps/api/src/index.ts &` → `curl /api/health` → 200 `{ok:true}`; `curl /api/models` → มี sonnet/opus/haiku; `curl /` → HTML ของ web; kills server หลังเทสต์
4. **Claude runner (dry):** `claude --version` ผ่าน; ตรวจคำสั่งที่ `ClaudeRunner` ประกอบ (unit ตรวจ argv มี `-p`, `--output-format stream-json`, `--model`, `--resume`) โดยไม่ยิงจริง (ต้อง auth + interactive)
5. **Plugin shim:** `plugins/web/scripts/start-web.sh --help` (หรือ `--port 4022 --dry-run`) พิมพ์คำสั่งที่ถูกต้องโดยไม่ start จริง; `plugin.json` valid JSON
6. **Boundary check:** `rg "from .*apps/api" packages/core packages/contracts apps/web/src` ต้องว่าง (ห้ามล้วง BE ตรง), `core` ห้าม import elysia/react
