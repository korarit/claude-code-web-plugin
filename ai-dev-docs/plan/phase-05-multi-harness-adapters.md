# Phase 5: Multi-Harness Adapters (`Claude CLI`, `Antigravity CLI`, `OpenCode`)

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 1](./phase-01-interactive-tmux-jsonl-hooks.md), [Phase 2](./phase-02-interactive-controls-and-discovery.md), [Phase 3](./phase-03-code-preview-and-file-changes.md)

## 1. Objective

ขยายระบบจาก Claude-only ให้รองรับ **3 Harnesses** ได้แก่ **Claude CLI (`claude`)**, **Antigravity CLI (`agy`)**, และ **OpenCode (`opencode`)** ในระดับ single-harness session (เริ่มและรัน session ของแต่ละเจ้าได้จาก UI เดียวกัน, normalize events, interactions, subagents และ file changes มาเป็น format กลางเดียวกัน) ก่อนที่จะต่อยอดเป็นการประสานและสลับ session ข้ามเจ้าใน [Phase 6](./phase-06-canonical-session-and-sync.md)

## 2. Harness Capabilities Matrix (Scope = 3 ตัวเท่านั้น)

| Harness | Binary | Start / Resume Command | Transcript / History Source | Real-time Events | Permission & Option UI |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Claude CLI** | `claude` | `tmux`: `claude --model <m>` / `--resume <id>` | `~/.claude/projects/<cwd>/<id>.jsonl` | Tail `.jsonl` + Claude Hooks (`settings.json`) | Permission: Blocking `PermissionRequest` hook hold; Options: `.jsonl` (`AskUserQuestion`) + `tmux send-keys` |
| **Antigravity CLI** | `agy` | `tmux`: `agy --model <m>` / `--conversation <id>` | `~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl` | Tail `transcript.jsonl` + AGY Hooks (`~/.gemini/antigravity-cli/hooks.json` / `.agents/hooks.json`) | Permission: Blocking `PreToolUse` hook hold (`auto_approve`/`deny`); Options: `transcript.jsonl` + `tmux capture-pane` & `send-keys` |
| **OpenCode** | `opencode` | `tmux`: `opencode -s <id>` หรือ `opencode serve` + `attach` | `~/.local/share/opencode/opencode.db` (SQLite) | `opencode serve` SSE (`GET /event`) หรือ watch SQLite / `opencode export` | Native SSE (`permission.asked`, `question.asked`) + REST endpoints (`/permission`, `/question`) |

## 3. Detailed Tasks

### 3.1 Contracts (`packages/contracts`)
- สร้าง `src/harness.ts`:
  - `HarnessId = "claude" | "agy" | "opencode"`
  - `HarnessDescriptor`: `{ id, name, binary, available: boolean, models: string[], capabilities: { hooks: boolean, jsonlTranscript: boolean, serverApi: boolean, resume: boolean, subagents: boolean } }`
- ขยาย `SessionInfo` และ `ChatSendRequest` ให้มี `harnessId: HarnessId`

### 3.2 Backend Architecture (`apps/api`)
- แยก bounded context `harness` (หรือ adapter registry ใต้ `infrastructure`):
  - **Port (`HarnessAdapter`):**
    - `id: HarnessId`
    - `detectAvailability(): Promise<boolean>` (ตรวจ `which <binary>`)
    - `listModels(): Promise<string[]>`
    - `startOrResumeSession(options): Promise<StartedHarnessSession>`
    - `sendPrompt(session, prompt): Promise<void>`
    - `sendInput(session, input): Promise<void>`
    - `observeEvents(session, onEvent): () => void`
  - **Adapters (3 ตัว) + Interaction / Subagent / FileChange Mapping:**
    1. `ClaudeHarnessAdapter`:
       - Refactor จาก `tmux-runner.ts` + `jsonl-watcher.ts` (Phase 1–3)
       - Permission ผ่าน blocking `PermissionRequest` hook; Option UI (`AskUserQuestion`) ผ่าน `.jsonl` + `tmux send-keys`
       - Subagents: ตาม `agent_transcript_path` จาก `SubagentStart` hook ส่งเข้า Subagent Tree & Drill-down (Phase 4)
       - File Changes: map tool calls (`Edit`, `Write`, `MultiEdit`) → `file_changed` พร้อม `harnessId: "claude"` และ `model` ที่แก้ (Phase 3)
    2. `AntigravityHarnessAdapter`:
       - ใช้ `tmux` run `agy` + `load-buffer`/`paste-buffer`
       - Tail `~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl` (map `USER_INPUT`, `PLANNER_RESPONSE`, `tool_calls`, `thinking` → `DomainChatEvent`)
       - Permission ผ่าน blocking `PreToolUse` hook (รองรับ decisions: `auto_approve` / `deny` / `ask` / `force_ask` — ไม่มี `PermissionRequest` หรือ `Notification` hook แยกเหมือน Claude); Option UI ผ่าน `transcript.jsonl` + `tmux capture-pane`/`send-keys` + Terminal Drawer fallback
       - Subagents: ตรวจจับ `invoke_subagent` จาก `transcript.jsonl` แล้ว tail `~/.gemini/antigravity-cli/brain/<subagentConvId>/.system_generated/logs/transcript.jsonl` เข้า Subagent Tree
       - File Changes: map file write/edit tools (`write_to_file`, `replace_file_content`, etc.) → `file_changed` พร้อม `harnessId: "agy"` และ `model` จริงของ turn นั้นสำหรับ `ChangesDrawer`
    3. `OpenCodeHarnessAdapter`:
       - บริหาร lifecycle ของ `opencode serve --port <ephemeral>` (เช่น 1 managed daemon ต่อ workspace หรือ attach เข้า `opencode serve` ที่รันอยู่แล้ว) พร้อม healthcheck และ clean shutdown
       - Normalize SSE events (`message.*`, `session.*`, `tool.*`, `permission.asked`, `question.asked`, file edit events) → `DomainChatEvent`, `PendingInteraction` & `file_changed` (แนบ `harnessId: "opencode"` และ `provider/model` ของ turn นั้น)
       - ส่งคำตอบ permission/question กลับผ่าน REST endpoints (`/permission`, `/question`) ของ OpenCode server โดยตรง
       - Subagents: subscribe `/global/event` แล้วจับ child sessions ที่มี `parentID` เข้า Subagent Tree & Drill-down
  - **Registry & Endpoint:** `HarnessRegistry` + `GET /api/harnesses` คืนรายการ 3 harnesses พร้อมสถานะความพร้อมบนเครื่อง, models ที่มีจริง และ agent profiles (`--agent` สำหรับ `claude` / `agy`)

### 3.3 Frontend (`apps/web`)
- `HarnessPicker`: เลือก `Claude CLI`, `Antigravity (agy)`, หรือ `OpenCode` ก่อนเริ่ม session ใหม่ (disable หรือขึ้น tooltip ถ้าเครื่องยังไม่ได้ติดตั้ง binary นั้น)
- `SessionSidebar`: แสดง badge ของ `harnessId` คู่กับ **loading spinner icon** ของแต่ละ session (เช่น Session 1 `Claude` กำลังหมุน, Session 2 `OpenCode` ว่างอยู่) และแสดง badge ใน header ของแชท

## 4. Exit Criteria / Verification

1. `GET /api/harnesses` ตรวจพบ `claude`, `agy`, `opencode` บนเครื่องได้ถูกต้องตามจริง
2. สามารถเปิด session แยกของแต่ละตัว (Claude / AGY / OpenCode) ส่ง prompt, รับ streaming events, และดูไฟล์เปลี่ยนใน `ChangesDrawer` ได้ครบทั้ง 3 เจ้า
3. เมื่อเกิด Permission prompt หรือ Option UI บนทั้ง 3 เจ้า (Claude `PermissionRequest`/`AskUserQuestion`, AGY `PreToolUse`/TUI, OpenCode `permission.asked`/`question.asked`) หน้าเว็บแสดง `PendingInteraction` เดียวกันและตอบกลับจนทำงานต่อได้
4. `chat` domain/application layer ไม่ผูกติดกับรูปแบบ event เฉพาะของเจ้าใดเจ้าหนึ่ง (ทุกเจ้า map เข้า `DomainChatEvent` / `PendingInteraction` กลางผ่าน adapter)
