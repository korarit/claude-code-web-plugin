# 20261113 — Interactive tmux / PTY Runner + JSONL Transcript & Hooks Observation

> Supersedes runner approach in [20261103-claude-web-ui.md](./20261103-claude-web-ui.md)
> Date (UTC): 2026-11-13

## 1. Goal / Background

- ลดความเสี่ยงเรื่อง ToS / anti-abuse จากการเรียก `claude -p --output-format stream-json` ซ้ำๆ ทุกข้อความ (ซึ่งเป็นการรันใน headless/print mode และ spawn process ใหม่ทุก turn)
- เปลี่ยนมาใช้การรัน `claude` CLI ใน **โหมด Interactive TUI ปกติ (มี TTY แท้)** ภายใน persistent session (`tmux` / PTY) แบบ 1 session = 1 process ยาว เหมือนผู้ใช้งานพิมพ์ผ่าน terminal ตามปกติ
- แยกฝั่ง **Read (สังเกตการณ์)** ออกจากฝั่ง **Write (ส่งคำสั่ง)**:
  - **Read:** เฝ้าอ่านไฟล์ transcript `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` แบบ real-time + รับ lifecycle events จาก **Claude Code Hooks** (`PreToolUse`, `PostToolUse`, `Notification`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop` ฯลฯ) เพื่ออัปเดตแชท, ContextBar, TaskTimeline และสถานะ agent บนหน้าเว็บแบบ real-time
  - **Write:** ส่ง prompt และคำตอบ interactive (เช่น permission confirm / AskUser) เข้าไปใน session ที่รันอยู่ผ่าน `tmux` (`load-buffer` + `paste-buffer` / `send-keys`) หรือ PTY stdin
- เปิดทางให้หน้าเว็บสามารถเกาะดูและสั่งงาน session ที่ผู้ใช้เปิด `claude` ไว้เองใน terminal ได้ด้วย (ไม่ใช่แค่ session ที่สร้างจากเว็บ)

## 2. Scope (In / Out)

### In

- **Backend (`apps/api` — `modules/chat`):**
  - แทนที่/เพิ่ม infrastructure adapter จาก `BunClaudeRunner` (`claude -p`) เป็น:
    - **Session Process Manager (`tmux` / PTY):** สร้าง, แสดงรายการ, ส่ง prompt (`sendPrompt`), ส่งการตอบกลับ interactive (`sendInput` / `sendKey`), และหยุด session (`claude --model <m>` หรือ `--resume <id>`)
    - **JSONL Transcript Watcher:** เฝ้าดูไฟล์ `~/.claude/projects/.../*.jsonl` แบบ incremental byte-offset tailing แล้วแปลงเป็น `DomainChatEvent` (`init`, `delta`, `tool`, `task`, `result`, `error`, `status`)
    - **Hooks Receiver (`POST /api/chat/hooks`):** endpoint ภายในสำหรับรับ JSON payload จาก Claude Code Hooks (`session_id`, `transcript_path`, `hook_event_name`, tool state) เพื่อจับสถานะ idle / thinking / waiting_permission / subagent ทันที
  - อัปเดต SSE / event stream (`GET /api/chat/sessions/:id/events` และ `POST /api/chat/send`) ให้รองรับทั้ง session ที่สร้างจากเว็บและ session ที่ค้นพบจาก `~/.claude/projects/`
- **Contracts (`packages/contracts`):**
  - ขยาย `src/chat.ts` ให้รองรับ session status (`idle | running | waiting_permission | stopped`), input/permission response DTO (`ChatInputRequest`), และ hook/transcript event types โดยยังคงเป็น pure TS zero-dep
- **Frontend (`apps/web`):**
  - ปรับ `features/chat` ให้ subscribe SSE stream ต่อ session (ดู real-time จาก `.jsonl` + Hooks)
  - รองรับสถานะรอ permission / คำถามจาก CLI และส่งคำตอบกลับจากหน้าเว็บได้
  - (Optional tab/drawer) แสดง raw terminal preview หรือ `tmux attach` command ของ session นั้นๆ
- **Plugin (`plugins/web`):**
  - เพิ่ม hook configuration example / installer หรือ `--settings` flag สำหรับยิง Claude Code Hooks มายัง `http://localhost:<port>/api/chat/hooks` เฉพาะตอนเปิด web UI

### Out

- ยังไม่ดึง/ถอด OAuth token จาก `~/.claude/.credentials.json` ไปยิง Anthropic API โดยตรงเด็ดขาด
- ยังไม่ทำ multi-user auth, multi-machine remote orchestration, หรือ cloud sandbox
- ยังไม่ทำ auto-loop / swarm bot ยิงข้อความอัตโนมัติแบบ unattended (เน้น human-in-the-loop เพื่อความปลอดภัยของบัญชี)
- ยังไม่ทำ SQLite/ORM ถาวร (ใช้ state จาก `tmux` + `~/.claude/projects/*.jsonl` + memory map เป็นหลัก)

## 3. Proposed Approach(es)

### Option 1: `tmux` Session Manager + `.jsonl` Watcher + Hooks (แนะนำหลัก)
- Backend สั่งงานผ่าน CLI `tmux` (`new-session -d`, `list-sessions`, `load-buffer`/`paste-buffer` + `send-keys Enter`, `capture-pane -p`)
- **Pros:**
  - Session ทนทานมาก (survive แม้ restart `apps/api` dev server)
  - ผู้ใช้สามารถ `tmux attach -t <name>` จาก terminal จริงเพื่อดูหรือพิมพ์สลับกับหน้าเว็บได้ตลอดเวลา
  - ส่งข้อความยาว/หลายบรรทัดได้ปลอดภัยผ่าน `tmux load-buffer` + `paste-buffer` ไม่พังเรื่อง shell escaping
  - ไม่ต้องพึ่ง native C++ addon (`node-pty`) บน Bun
- **Cons:**
  - เครื่องต้องติดตั้ง `tmux` (Linux/macOS มีปกติ)
  - การจับว่า Claude พร้อมรับข้อความหรือกำลังค้าง prompt ต้องอาศัย Hooks + `capture-pane` ประกอบกัน

### Option 2: Native PTY (`Bun.spawn` terminal / `node-pty`) + `xterm.js` + `.jsonl` Watcher + Hooks
- Backend เปิด pseudo-terminal เองตรงๆ แล้ว bridge WebSocket ↔ `xterm.js` บนหน้าเว็บ
- **Pros:**
  - ไม่ต้องพึ่ง `tmux` บนเครื่อง
  - Embedded interactive terminal ใน browser (`xterm.js`) ลื่นไหลแบบ real-time
- **Cons:**
  - ถ้า `apps/api` restart/crash ทุก session ที่เปิดอยู่จะตายหมด
  - Attach จาก terminal ภายนอกเครื่องไม่ได้
  - ความเข้ากันได้ของ `node-pty` กับ Bun บนบาง environment อาจมีปัญหา build/ABI

### Option 3: Hybrid (`tmux` เป็น Session Backend + Optional PTY Attach สำหรับ Web Terminal)
- ใช้ `tmux` คุม lifecycle และส่งคำสั่ง (`send-keys` / `paste-buffer`) + `.jsonl` Watcher & Hooks เป็นหลัก แล้วเปิดช่อง attach `tmux` ผ่าน PTY → WebSocket (`xterm.js`) เฉพาะตอนผู้ใช้กดเปิดดู raw terminal
- **Pros:**
  - ได้ทั้งความอึดของ `tmux` (restart server ไม่หลุด + `tmux attach` นอกเว็บได้) และดูจอ terminal สดในเว็บได้เมื่อจำเป็น
- **Cons:**
  - งาน phase แรกซับซ้อนขึ้นเล็กน้อย (แต่แยก PTY viewer เป็นเฟสถัดไปได้)

### Recommended: Option 1 (เริ่มด้วย `tmux` + `.jsonl` + Hooks และเผื่อ port สำหรับ Hybrid PTY Viewer ในอนาคต)
- **Reason:** ตอบโจทย์เรื่องความทนทานของ session, ความปลอดภัยในการใช้งานแบบ interactive TUI จริง, ไม่ต้องพึ่ง native addon, และยังสอดคล้องกับ DDD port/adapter ใน `apps/api/src/modules/chat` โดยเปลี่ยนเฉพาะ `infrastructure` + เพิ่ม `hooks` endpoint

## 4. File-level Change Plan

```text
packages/contracts/src/chat.ts
  - เพิ่ม SessionStatus ("idle" | "running" | "waiting_permission" | "stopped")
  - เพิ่ม SessionOrigin ("web" | "cli" | "tmux" | "ide" | "opencode_server") และ SessionControlMode ("interactive" | "mirror")
  - เพิ่ม ChatInputRequest (สำหรับตอบ y/n/text เข้า interactive prompt)
  - เพิ่ม SessionInfo fields (title?, archivedAt?, origin, controlMode, externalSessionId?, discoveredAt?, tmuxSession?, transcriptPath?, status) + SessionUpdateRequest

apps/api/src/
  env.ts                        # bind 127.0.0.1 default + parse port
  index.ts                      # เขียน/ลบ ~/.harness-web/runtime.json ({port, pid, token}) + static serve
apps/api/src/modules/chat/
  domain/
    session.entity.ts           # เพิ่ม status + title + archivedAt + origin + controlMode + externalSessionId + transcriptPath + tmuxSessionName
    chat.events.ts              # เพิ่ม status / permission_prompt event types
    repository.port.ts          # ปรับ interface รองรับ lookup by transcriptPath / externalSessionId, filter (origin/cwd/q) + delete
    errors.ts                   # เพิ่ม TmuxNotFoundError / SessionBusyError
  application/
    ports.ts                    # แยก TerminalRunnerPort (start/sendPrompt/sendKey/abort/stop) + TranscriptWatcherPort
    send-message.usecase.ts     # ส่งข้อความเข้า active tmux session (สร้างใหม่ถ้ายังไม่มี)
    handle-hook.usecase.ts      # รับ hook event -> อัปเดต session status & broadcast ให้ subscribers
    index.ts
  infrastructure/
    tmux-runner.ts              # implement TerminalRunnerPort ด้วย tmux CLI (--session-id, -e env, abort C-c)
    jsonl-watcher.ts            # tail ~/.claude/projects/.../*.jsonl แบบ incremental byte offset + usage mapping
    session.repository.ts       # persistent ~/.harness-web/sessions.json + discovery จาก ~/.claude/projects/ และ tmux
    claude-runner.ts            # (ลบหรือเก็บไว้เป็น fallback/legacy mode ตามการตัดสินใจตอน implement)
  presentation/
    chat.routes.ts              # เพิ่ม SSE sidebar/session, POST /send, /abort, PATCH /sessions/:id, DELETE /sessions/:id, GET /sessions?origin&cwd&q, /input, /hooks

apps/web/
  index.html                    # zero-FOUC theme init script
  src/styles.css                # semantic light/dark CSS tokens (Tailwind v4)
  src/lib/i18n/                 # locales/en.ts, I18nProvider, useTranslation() (English-only UI copy)
  src/lib/theme/                # ThemeProvider (system default | light | dark)
  src/features/chat/
    api.ts                      # subscribeSessionEvents, subscribeSessionsListEvents, sendChat, sendInput, updateSession, abortSession, deleteSession
    hooks/useChat.ts            # sync state จาก SSE stream ของ session แทนการรอ response ราย request
    hooks/useSessions.ts        # sync รายการ sessions + origin/cwd filter + live status สำหรับ sidebar
    layouts/DesktopShell.tsx    # >= 1280px: Multi-pane split layout (Sidebar + Chat + future side panels)
    layouts/CompactShell.tsx    # < 1280px: Slide-over drawer Sidebar + single-focus Chat/tab view
    components/WorkspacePage.tsx# ถือ shared state (useSessions + useChat) + resource route /sessions/:id
    components/SessionSidebar.tsx # แสดงรายการ sessions + origin badge + filter + loading icon + rename, archive/unarchive, permanent delete
    components/ChatPanel.tsx    # Reusable Chat UI: Markdown/tool collapse, ปุ่ม Abort, status badge + input bar
    components/TaskTimeline.tsx # อัปเดตจาก .jsonl + hook events

plugins/web/
  hooks/hooks.json              # hook config (หรือ script ส่งต่อ event เข้า local API เมื่อ WEB_PORT ถูกตั้งไว้)
  scripts/hook-forwarder.sh     # อ่าน stdin JSON จาก Claude Code Hook แล้ว curl/POST ไปยัง /api/chat/hooks (no-op ถ้าเว็บไม่รัน)
  scripts/start-web.sh          # ส่ง env / hook setup สำหรับ session
```

## 5. Test / Verification Plan

1. **Typecheck & Build:** `bun run typecheck` และ `bun run build` ต้องผ่านทุก workspace (`core`, `contracts`, `api`, `web`)
2. **Boundary check:** `rg "from .*apps/api" packages/core packages/contracts apps/web/src` ต้องว่างเปล่า; `packages/core` ห้าม import external libs
3. **Unit tests (Infrastructure mappers & args):**
   - ทดสอบ `jsonl-watcher` parser: แปลงบรรทัด `.jsonl` จริงของ Claude Code (`user`, `assistant`, `tool_use`, `tool_result`, `system`, `parent_tool_use_id`) เป็น `DomainChatEvent` ได้ครบถ้วน
   - ทดสอบ `tmux-runner` command builder: ตรวจคำสั่ง `new-session`, `load-buffer`/`paste-buffer` สำหรับข้อความที่มี newline/special chars, และ `send-keys`
   - ทดสอบ `handle-hook.usecase`: เมื่อได้รับ `PreToolUse` / `Stop` / `Notification` status ของ session เปลี่ยนถูกต้อง
4. **Integration Smoke (with local server + dummy/real tmux):**
   - `GET /api/health` → 200
   - `POST /api/chat/hooks` ด้วย sample JSON payload → อัปเดตสถานะ session และยิง event ออก SSE `/api/chat/sessions/:id/events`
   - ทดสอบสร้าง tmux session จริง (หรือ mock `tmux` binary) แล้วส่งข้อความผ่าน `POST /api/chat/send` และเห็น event ไหลกลับจากไฟล์ `.jsonl`
5. **Plugin Hook Safety:** `plugins/web/scripts/hook-forwarder.sh` เมื่อเว็บไม่ได้เปิดอยู่ ต้อง exit 0 ทันทีโดยไม่บล็อกการทำงานของ Claude CLI ปกติ
