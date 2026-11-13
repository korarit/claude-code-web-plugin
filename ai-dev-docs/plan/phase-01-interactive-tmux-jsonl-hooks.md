# Phase 1: Interactive `tmux` Runner + `.jsonl` Watcher + Hooks

> **Status:** 🚧 Next  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Feature Doc:** [20261113-interactive-tmux-jsonl-runner.md](../feature/20261113-interactive-tmux-jsonl-runner.md)  
> **Depends On:** [Phase 0](./phase-00-monorepo-and-v1-spike.md)

## 1. Objective

เปลี่ยนแกนประมวลผลจาก headless `claude -p` เป็นการรัน `claude` CLI ในโหมด **Interactive TUI ปกติ** ภายใน `tmux` session (1 session = 1 persistent process) และแยกฝั่ง Read ออกมาเป็น **JSONL Transcript Watcher + Claude Code Hooks Receiver**

## 2. Target Architecture & Data Flow

```text
[Web UI (React)]
   │  POST /api/chat/send { prompt, sessionId?, model? }
   ▼
[apps/api: chat.routes -> SendMessageUsecase]
   │  1) ensure tmux session exists (new-session running `claude`)
   │  2) send prompt via `tmux load-buffer` + `paste-buffer` + `send-keys Enter`
   ▼
[tmux session: `claude` Interactive TUI]
   ├──► writes append-only log ──► ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
   │                                      │
   │                                      ▼ (fs.watch / incremental byte-offset tail)
   │                               [jsonl-watcher.ts] ──► DomainChatEvent
   │                                                           │
   └──► fires lifecycle hooks ───► [hook-forwarder.sh]         ▼
         (PreToolUse, Stop, ...)      │  POST /api/chat/hooks  [SessionEventBus]
                                      └──────────────────────► SSE: GET /api/chat/sessions/:id/events
                                                                     │
                                                                     ▼
                                                              [Web UI (EventSource)]
```

## 3. Detailed Tasks

### 3.1 `packages/contracts/src/chat.ts`
- เพิ่ม `SessionStatus = "idle" | "running" | "waiting_permission" | "stopped"`
- ขยาย `SessionInfo`:
  - `title?: string` (ชื่อที่ผู้ใช้ตั้งเอง; fallback เป็น preview ข้อความแรก)
  - `status: SessionStatus`
  - `tmuxSession?: string`
  - `transcriptPath?: string`
  - `cwd?: string`
  - `archivedAt?: string | null`
- เพิ่ม `SessionUpdateRequest`: `{ title?: string; archived?: boolean }`
- ขยาย `ChatEventType` เพิ่ม `"status"` และ `"permission_prompt"` (optional payload สำหรับแจ้งว่ากำลังรอ input)
- คงกฎ pure TypeScript zero external dependency

### 3.2 `apps/api/src/modules/chat/domain/`
- `session.entity.ts`: เพิ่ม state transition methods (`markRunning()`, `markIdle()`, `markWaitingPermission()`, `attachTranscript(path)`, `rename(title)`, `archive()`, `unarchive()`)
- `chat.events.ts`: เพิ่ม `DomainStatusEvent`, `DomainHookEvent`
- `repository.port.ts`: เพิ่ม `findByTmuxSession(name)`, `findByTranscriptPath(path)`, `delete(id)`
- `errors.ts`: เพิ่ม `TmuxNotAvailableError`, `SessionNotRunningError`

### 3.3 `apps/api/src/modules/chat/application/`
- `ports.ts`:
  - `TerminalRunnerPort`: `ensureSession(options)`, `sendPrompt(sessionId, prompt)`, `sendRawKeys(sessionId, keys)`, `listActiveSessions()`, `stopSession(sessionId)`
  - `TranscriptWatcherPort`: `watch(transcriptPath, onEvent)`, `unwatch(transcriptPath)`
  - `EventBusPort`: pub/sub ต่อ `sessionId` เพื่อกระจาย event จากทั้ง watcher และ hooks ไปยัง SSE clients
- `send-message.usecase.ts`:
  - แทนที่การ return stream จาก `runStream()` เป็นการส่ง prompt เข้า `TerminalRunnerPort` และตอบกลับ `session` ทันที (ผลลัพธ์จริงไหลผ่าน SSE endpoint ของ session)
- `handle-hook.usecase.ts`:
  - Map hook events (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`) เป็นการอัปเดต `SessionStatus`, ผูก `transcript_path`, และ publish event เข้า `EventBusPort`

### 3.4 `apps/api/src/modules/chat/infrastructure/` & Server Security
- `env.ts` / `index.ts`:
  - Bind เฉพาะ `127.0.0.1` เป็นค่าเริ่มต้น (ห้ามเปิด `0.0.0.0` โดยไม่มี auth เพื่อป้องกัน remote RCE ผ่าน `tmux send-keys`)
  - สร้าง runtime lock/discovery file `~/.harness-web/runtime.json` (`{ port, pid, token }`) ตอน startup และลบตอน graceful shutdown; ตรวจ local token / origin สำหรับ endpoints สำคัญ
- `session.repository.ts`:
  - เปลี่ยนจาก In-Memory ล้วนเป็น **Lightweight Persistent Store** (`~/.harness-web/sessions.json` + in-memory cache) เก็บ `{ id, tmuxSession, transcriptPath, cwd, model, status }` เพื่อให้ restart `apps/api` แล้วกลับมาเฝ้าต่อได้จริง
- `tmux-runner.ts`:
  - ตั้งชื่อ session deterministic เช่น `cw-<shortId>`
  - สร้าง session ด้วย `tmux new-session -d -s <name> -c <cwd> -e CLAUDE_WEB_SESSION_ID=<id> -e CLAUDE_WEB_PORT=<port> -e CLAUDE_WEB_TOKEN=<token> "claude --session-id <uuid> --model <m>"` (รู้ `.jsonl` path ทันที + ผูก session ตั้งแต่ hook แรก)
  - ส่งข้อความ multi-line อย่างปลอดภัย: เขียนผ่าน stdin → `tmux load-buffer -b <buf> -` → `tmux paste-buffer -b <buf> -t <name>` → `tmux send-keys -t <name> Enter` (แก้ปัญหา special chars และ newline)
  - เพิ่ม `abortSession(name)` (`tmux send-keys -t <name> C-c`) และ `killSession(name)` (`tmux kill-session -t <name>`)
  - รอ Claude CLI boot พร้อมรับ input ใน session ใหม่ (ใช้ `SessionStart` hook หรือ fallback poll `capture-pane`)
- `jsonl-watcher.ts`:
  - เก็บ `byteOffset` ต่อไฟล์ อ่านเฉพาะส่วนที่ append ใหม่ (ไม่ re-read ทั้งไฟล์)
  - จัดการ partial line buffer กรณีเขียนยังไม่จบ `\n`
  - แปลง record จาก Claude Code `.jsonl` (`user`, `assistant`, `system`, `progress`, `tool_use`, `tool_result`, `parent_tool_use_id`) → `DomainChatEvent`
  - คำนวณ token usage จาก `message.usage` (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`) เทียบกับ context window limit ของโมเดลเพื่อส่งให้ `ContextBar`
- `event-bus.ts`: in-memory `Map<sessionId, Set<Subscriber>>` สำหรับ fan-out ไปยังหลาย browser tab

### 3.5 `apps/api/src/modules/chat/presentation/chat.routes.ts`
- `POST /api/chat/send` → สร้าง/ใช้ session เดิม ส่ง prompt เข้า `tmux` แล้วคืน `{ session }` (202 / 200)
- `PATCH /api/chat/sessions/:id` → rename (`title`) หรือ archive / unarchive (`archived: boolean`, ถ้า archive ให้หยุด/detach หรือคงประวัติไว้เปิดดูได้)
- `POST /api/chat/sessions/:id/abort` → ส่ง `Ctrl+C` หยุดงานที่กำลังรันอยู่กลางคัน
- `DELETE /api/chat/sessions/:id` → **ลบถาวร**: kill `tmux` session (ถ้ายังรันอยู่), ลบออกจาก `~/.harness-web/sessions.json` และลบ cache/snapshots ของ session นั้นออกทั้งหมด
- `GET /api/chat/sessions?archived=false|true|all` → list sessions พร้อม `status` ล่าสุด (`idle` / `running` / `waiting_permission` / `stopped`)
- `GET /api/chat/sessions/events` → global SSE stream สำหรับ Session Sidebar (อัปเดตสถานะ `running` / `idle` / `waiting_permission` รวมถึง event rename/archive/delete แบบ real-time)
- `GET /api/chat/sessions/:id/events` → SSE stream ต่อ `sessionId` (replay recent events จาก `.jsonl` + stream real-time ต่อ)
- `POST /api/chat/hooks` → รับ JSON payload จาก `hook-forwarder.sh`

### 3.6 `plugins/web/`
- `scripts/hook-forwarder.sh`: อ่าน stdin JSON จาก Claude Code Hook, อ่าน port/token จาก `CLAUDE_WEB_PORT` หรือ `~/.harness-web/runtime.json`, ถ้ามี server รันอยู่ให้ `curl -sS -m 1 -X POST http://127.0.0.1:${PORT}/api/chat/hooks ...` และ **ต้อง exit 0 เสมอ** แม้ server ปิดอยู่
- `hooks/hooks.json` (หรือ config snippet ใน plugin): ลงทะเบียน hooks ที่จำเป็น

### 3.7 `apps/web/` (ตามกติกา Option 3 + [ui-concept.md](../arc/ui-concept.md))
- **i18n & Theme Foundation (`apps/web/src/lib/` + `index.html` / `styles.css`):**
  - `lib/i18n/`: `locales/en.ts` (English-only copy ทั้งหมด), `I18nProvider.tsx`, `useTranslation()` (typed `t(...)`, interpolation) — ห้าม hardcode UI string ใน JSX
  - `lib/theme/`: `ThemeProvider.tsx` (`"system" | "light" | "dark"`, default `"system"`), inline zero-FOUC script ใน `index.html`, semantic light/dark CSS tokens ใน `styles.css`, และปุ่มสลับ theme บน Top Bar
- `features/chat/api.ts`: เพิ่ม `subscribeSessionEvents`, `subscribeSessionsListEvents`, `updateSession`, `abortSession`, `deleteSession`
- `features/chat/hooks/useChat.ts` + `hooks/useSessions.ts`: แยก action `send()` ออกจาก subscription stream ของ session; sync รายการ session และสถานะแบบ real-time; เมื่อเปิดเว็บใหม่หรือรีเฟรชหน้า ยังโหลดประวัติ + ตาม stream ต่อได้
- **Single Resource Route + Shared State (`WorkspacePage.tsx`):**
  - รองรับ URL `/sessions/:id` (ซิงค์กับ browser history โดยไม่ reload) และถือ `useSessions()` + `useChat()` ไว้ที่ `WorkspacePage` ชั้นเดียว เพื่อไม่ให้ SSE หลุดตอน resize หน้าต่างข้าม `1280px`
- **2 Responsive Layout Shells (Breakpoint `1280px` / `xl`):**
  - `layouts/DesktopShell.tsx` (`>= 1280px`): Split View `[SessionSidebar (260px)] | [ChatPanel (flex-1)]` + Top Bar (Rename, ContextBar, Theme toggle)
  - `layouts/CompactShell.tsx` (`< 1280px`): Compact Header ปุ่ม `☰` เปิด `SessionSidebar` แบบ Slide-over Drawer (พร้อมจุดแจ้งเตือนเมื่อมีห้อง background กำลังรัน) + `ChatPanel` เต็มความกว้างจอ
- `components/SessionSidebar.tsx` (Reusable Panel):
  - แสดงรายการ sessions ทั้งหมดที่เปิดอยู่ (ชื่อที่ตั้งเอง/preview ข้อความแรก, `model` badge, เวลาอัปเดตล่าสุด) และปุ่ม `+ New Session`
  - **Session Actions:** กด **Rename** (inline edit), **Archive / Unarchive** (ส่วน `Archived` พับเก็บได้ด้านล่าง), และ **Delete Permanently** (พร้อม confirm modal กันกดพลาด)
  - **Live Status Indicator:** ถ้า session ไหนกำลังทำงาน (`status === "running"`) ให้แสดง **loading spinner icon** หมุนอยู่ข้างชื่อ session (แม้กำลังเปิดดู session อื่นอยู่), และแสดง badge แจ้งเตือนเมื่อ `status === "waiting_permission"`
  - คลิกสลับดู session ใดก็ได้โดยไม่ขัดจังหวะ session อื่นที่กำลังทำงานใน background
- `components/ChatPanel.tsx` / `ChatView.tsx` (Reusable Panel): แสดงสถานะ session, ปุ่ม **Stop/Abort** ตอนกำลังรัน, Markdown + code copy rendering, และ collapsible tool call blocks (`Read`, `Edit`, `Bash`)

## 4. Edge Cases & Mitigations

- **ส่งข้อความระหว่าง Claude กำลัง boot:** buffer หรือรอ hook `SessionStart` / prompt marker ก่อนส่ง `paste-buffer`
- **ส่งข้อความตอน Claude กำลังทำงานอยู่:** เช็ค `session.status`; reject ด้วย `409 Conflict` หรือเข้าคิว (Phase 1 ให้ reject ชัดเจนก่อนเพื่อกันข้อความชนกันใน TUI)
- **ไม่มี `tmux` ในเครื่อง:** เช็ค `which tmux` ตอน startup / `ensureSession` และคืน `TmuxNotAvailableError` พร้อมวิธีติดตั้งที่ชัดเจน

## 5. Exit Criteria / Verification

1. `bun run typecheck` และ `bun run build` ผ่านทุก workspace
2. Unit tests:
   - `jsonl-watcher` parser อ่านตัวอย่าง `.jsonl` จริงของ Claude Code ได้ครบ (`text`, `tool_use`, `usage`, `parent_tool_use_id`)
   - `tmux-runner` command builder จัดการ newline / quotes ได้ถูกต้อง
   - `handle-hook.usecase` เปลี่ยน `SessionStatus` ตรงตาม hook event
3. Smoke test:
   - เปิด server → `POST /api/chat/hooks` ด้วย mock payload → SSE `/api/chat/sessions/:id/events` และ `/api/chat/sessions/events` ได้รับ event ทันที
   - ทดสอบกับ `tmux` session จริง: ส่งข้อความจากเว็บ → เห็นข้อความเข้า terminal → เห็นคำตอบไหลกลับหน้าเว็บ real-time → restart API server แล้วโหลด `~/.harness-web/sessions.json` กลับมาเฝ้าต่อได้
   - ทดสอบ Abort, Rename, Archive & Permanent Delete: กด Stop (`Ctrl+C`) หยุดงานได้, Rename แล้วชื่อจำอยู่หลัง restart, Archive ย้ายไปส่วน Archived และ unarchive กลับมาได้, และ Delete ถาวรปิด `tmux` พร้อมลบออกจาก `sessions.json` สะอาด
   - ทดสอบเปิด 2 sessions พร้อมกัน: สั่งงาน Session A แล้วกดสลับไปดู Session B → **Session Sidebar** แสดง **loading icon** บน Session A จนกว่าจะทำงานเสร็จ (`Stop` hook → `idle`)
   - ทดสอบ Responsive Layout (`>= 1280px` ↔ `< 1280px`): ย่อขยายหน้าต่างข้าม `1280px` ระหว่างที่ session กำลัง streaming → สลับจาก `DesktopShell` เป็น `CompactShell` (drawer sidebar) ได้โดย **SSE stream และ draft ข้อความไม่หลุด**
   - ทดสอบ Theme & i18n: default ตาม OS `prefers-color-scheme`, สลับ `System` / `Light` / `Dark` แล้วไม่กระพริบหลังรีเฟรช, ข้อความ UI ทั้งหมดเป็นภาษาอังกฤษผ่าน `locales/en.ts`
4. `hook-forwarder.sh` เมื่อ server ปิดอยู่ต้องจบด้วย exit code `0` ภายใน `< 200ms`
