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
  - `status: SessionStatus`
  - `tmuxSession?: string`
  - `transcriptPath?: string`
  - `cwd?: string`
- ขยาย `ChatEventType` เพิ่ม `"status"` และ `"permission_prompt"` (optional payload สำหรับแจ้งว่ากำลังรอ input)
- คงกฎ pure TypeScript zero external dependency

### 3.2 `apps/api/src/modules/chat/domain/`
- `session.entity.ts`: เพิ่ม state transition methods (`markRunning()`, `markIdle()`, `markWaitingPermission()`, `attachTranscript(path)`)
- `chat.events.ts`: เพิ่ม `DomainStatusEvent`, `DomainHookEvent`
- `repository.port.ts`: เพิ่ม `findByTmuxSession(name)` และ `findByTranscriptPath(path)`
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

### 3.4 `apps/api/src/modules/chat/infrastructure/`
- `tmux-runner.ts`:
  - ตั้งชื่อ session deterministic เช่น `cw-<shortId>`
  - สร้าง session ด้วย `tmux new-session -d -s <name> -c <cwd> "claude --model <m>"` (หรือ `--resume <id>`)
  - ส่งข้อความ multi-line อย่างปลอดภัย: เขียนไฟล์ temp/stdin → `tmux load-buffer -b <buf> -` → `tmux paste-buffer -b <buf> -t <name>` → `tmux send-keys -t <name> Enter` (แก้ปัญหา special chars และ newline)
  - รอ Claude CLI boot พร้อมรับ input ใน session ใหม่ (ใช้ `SessionStart` hook หรือ fallback poll `capture-pane`)
- `jsonl-watcher.ts`:
  - เก็บ `byteOffset` ต่อไฟล์ อ่านเฉพาะส่วนที่ append ใหม่ (ไม่ re-read ทั้งไฟล์)
  - จัดการ partial line buffer กรณีเขียนยังไม่จบ `\n`
  - แปลง record จาก Claude Code `.jsonl` (`user`, `assistant`, `system`, `progress`, `tool_use`, `tool_result`, `parent_tool_use_id`, token usage) → `DomainChatEvent`
- `event-bus.ts`: in-memory `Map<sessionId, Set<Subscriber>>` สำหรับ fan-out ไปยังหลาย browser tab

### 3.5 `apps/api/src/modules/chat/presentation/chat.routes.ts`
- `POST /api/chat/send` → สร้าง/ใช้ session เดิม ส่ง prompt เข้า `tmux` แล้วคืน `{ session }` (202 / 200)
- `GET /api/chat/sessions` → list sessions พร้อม `status` ล่าสุด (`idle` / `running` / `waiting_permission` / `stopped`)
- `GET /api/chat/sessions/events` → global SSE stream สำหรับ Session Sidebar (อัปเดตสถานะ `running` / `idle` / `waiting_permission` ของทุก session แบบ real-time แม้ไม่ได้เปิดห้องนั้นอยู่)
- `GET /api/chat/sessions/:id/events` → SSE stream ต่อ `sessionId` (replay recent events จาก `.jsonl` + stream real-time ต่อ)
- `POST /api/chat/hooks` → รับ JSON payload จาก `hook-forwarder.sh`

### 3.6 `plugins/web/`
- `scripts/hook-forwarder.sh`: อ่าน stdin JSON จาก Claude Code Hook, อ่าน `CLAUDE_WEB_PORT` (หรือ port file/env), ถ้ามี server รันอยู่ให้ `curl -sS -m 1 -X POST http://127.0.0.1:${PORT}/api/chat/hooks ...` และ **ต้อง exit 0 เสมอ** แม้ server ปิดอยู่
- `hooks/hooks.json` (หรือ config snippet ใน plugin): ลงทะเบียน hooks ที่จำเป็น

### 3.7 `apps/web/src/features/chat/`
- `api.ts`: เพิ่ม `subscribeSessionEvents(sessionId, onEvent)` และ `subscribeSessionsListEvents(onUpdate)` ด้วย `EventSource`
- `hooks/useChat.ts` + `hooks/useSessions.ts`: แยก action `send()` ออกจาก subscription stream ของ session; sync รายการ session และสถานะแบบ real-time; เมื่อเปิดเว็บใหม่หรือรีเฟรชหน้า ยังโหลดประวัติ + ตาม stream ต่อได้
- `components/SessionSidebar.tsx`:
  - แสดงรายการ sessions ทั้งหมดที่เปิดอยู่ (ชื่อ/preview ข้อความแรก, `model` badge, เวลาอัปเดตล่าสุด) และปุ่ม `+ New Session`
  - **Live Status Indicator:** ถ้า session ไหนกำลังทำงาน (`status === "running"`) ให้แสดง **loading spinner icon** หมุนอยู่ข้างชื่อ session (แม้กำลังเปิดดู session อื่นอยู่), และแสดง badge แจ้งเตือนเมื่อ `status === "waiting_permission"`
  - คลิกสลับดู session ใดก็ได้โดยไม่ขัดจังหวะ session อื่นที่กำลังทำงานใน background
- `components/ChatView.tsx`: จัด layout แบบ Sidebar + Main Chat Area และแสดงสถานะ session (`idle`, `running`, `waiting_permission`)

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
   - ทดสอบกับ `tmux` session จริง: ส่งข้อความจากเว็บ → เห็นข้อความเข้า terminal → เห็นคำตอบไหลกลับหน้าเว็บ real-time → restart API server แล้ว session ยังทำงานต่อได้
   - ทดสอบเปิด 2 sessions พร้อมกัน: สั่งงาน Session A แล้วกดสลับไปดู Session B → **Session Sidebar** แสดง **loading icon** บน Session A จนกว่าจะทำงานเสร็จ (`Stop` hook → `idle`)
4. `hook-forwarder.sh` เมื่อ server ปิดอยู่ต้องจบด้วย exit code `0` ภายใน `< 200ms`
