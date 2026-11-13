# Phase 2: Interactive Controls, Session Discovery & Auth Modes

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 1](./phase-01-interactive-tmux-jsonl-hooks.md)

## 1. Objective

ยกระดับจากการแค่ "ส่ง prompt ไป-กลับ" ให้ควบคุม interactive session ได้ครบเหมือนนั่งหน้า terminal จริง, ค้นพบ session ที่เปิดนอกเว็บได้, และควบคุมโหมด Auth (`Subscription` vs `API Key`) เพื่อความปลอดภัยสูงสุด

## 2. Scope & Detailed Tasks

### 2.1 Interactive Permission & Question Handling (`PendingInteraction` 2-Tier Model)
- **ปัญหาที่แก้:** ใน Phase 0 (`-p`) permission ถูก deny-by-default; ใน Phase 1 (`tmux`) CLI จะหยุดรอผู้ใช้ตอบ Permission (`Allow / Always Allow / Deny`) หรือ Option UI (`AskUserQuestion` / multiple choice) ใน TUI
- **Contracts (`packages/contracts`):**
  - เพิ่ม unified type `PendingInteraction`:
    - `kind: "permission"` (`id`, `toolName`, `commandOrTarget`, `options`: Allow Once / Always Allow / Deny)
    - `kind: "question"` (`id`, `questions[]`: `prompt`, `multiSelect`, `options[]`, `allowCustomText`)
  - `POST /api/chat/input`: รับ `{ sessionId, interactionId?, inputType: "decision" | "selection" | "text" | "key", value }`
- **Backend — 2 กลไกหลัก:**
  1. **Blocking Hook Hold สำหรับ Permission (`PermissionRequest`):**
     - `hook-forwarder.sh` ส่ง request เข้า `POST /api/chat/hooks` แล้ว **hold HTTP connection (long-poll)** รอคำตัดสินจากเว็บ (มี timeout fallback: ถ้าเว็บปิดหรือเกินเวลา ให้ exit ปกติเพื่อให้ TUI ถามใน terminal ตามเดิม ไม่ hang CLI)
     - เมื่อผู้ใช้กด Allow / Deny บนเว็บ → API ตอบ JSON กลับไปยัง hook ทันทีโดยไม่ต้องเดากดปุ่มใน `tmux`
  2. **Structured Transcript + `tmux` Key Injection สำหรับ Option UI (`AskUserQuestion`):**
     - อ่านคำถามและตัวเลือกเต็มๆ จาก `.jsonl` (`tool_use`) เพื่อ render การ์ดตัวเลือกบนหน้าเว็บ
     - ยืนยันหน้าจอด้วย `tmux capture-pane` แล้วส่ง keystrokes เข้า `tmux` (`sendKey`: ตัวเลข, `Up`/`Down`, `Space` สำหรับ multi-select, `Enter`, หรือข้อความ custom)
     - รอ confirm จาก `.jsonl` (`toolUseResult` / `PostToolUse`) ก่อนเคลียร์ `PendingInteraction` บนหน้าเว็บ
- **Frontend:**
  - `InteractionCard` (`PermissionBanner` + `QuestionCard`) ใน `ChatView.tsx`: render ปุ่ม Allow / Deny, Radio / Checkbox options, ช่องพิมพ์ตอบเอง, และปุ่มเปิด Terminal Fallback หากเจอ TUI dialog ที่ parser ไม่รู้จัก

### 2.2 External Session Discovery
- **เป้าหมาย:** ผู้ใช้เปิด `claude` เองใน terminal หรือ `tmux` นอกเว็บ แล้วเปิดหน้าเว็บมาดู/สั่งต่อได้ทันที
- **Backend (`session.repository.ts`):**
  - Scan `~/.claude/projects/<encoded-cwd>/*.jsonl` เพื่อดึงประวัติ session เดิมและสถิติ usage ล่าสุด
  - Scan `tmux list-sessions` + `tmux list-panes -F "#{session_name} #{pane_current_command} #{pane_pid}"` เพื่อตรวจจับ session ที่กำลังรัน `claude` อยู่
  - จับคู่ `tmux` session กับ `.jsonl` ผ่าน Hook payload (`session_id` + `transcript_path`) หรือ `cwd` + `mtime`
  - เพิ่ม `POST /api/chat/sessions/:id/resume` สำหรับเปิด `tmux` session ใหม่โดยต่อ `--resume <id>` จากประวัติเดิม

### 2.3 Optional Live Terminal Drawer (Hybrid `tmux` + PTY Attach)
- **Backend:** เพิ่ม WebSocket endpoint `/api/chat/sessions/:id/terminal` ที่ spawn `tmux attach-session -t <name>` ผ่าน PTY (หรือ fallback เป็น `tmux capture-pane` polling ถ้าเครื่องไม่มี PTY support)
- **Frontend:** ปุ่มเปิด Terminal Drawer (`xterm.js`) สำหรับดู TUI สดๆ หรือกดปุ่ม copy คำสั่ง `tmux attach -t <name>` ไปเปิดใน terminal ของเครื่อง

### 2.4 Auth Mode & Anti-Ban Safety Guardrails
- **Contracts & UI:**
  - เพิ่มตัวเลือก `authMode?: "machine_default" | "api_key"` ในการสร้าง session
  - รองรับการส่ง `ANTHROPIC_API_KEY` จาก env ของ server (ห้ามรับ/เก็บ key ฝั่ง client ใน plaintext storage ระยะยาว; อ่านจาก server env หรือ profile config ของเครื่อง)
  - แสดง indicator ชัดเจนว่า session นี้กำลังรันด้วย **API Key (Pay-as-you-go)** หรือ **Local CLI OAuth**
- **Safety Guards (โหมด Local CLI OAuth):**
  - จำกัด concurrent active sessions ที่รันพร้อมกัน (เช่น default soft-warning เมื่อเปิดเกิน 2–3 sessions)
  - ป้องกัน double-submit / accidental rapid loop จาก UI (debounce + lock ระหว่าง `running`)

### 2.5 Multi-Project `cwd`, Agent Profile, Slash Commands & Image Input
- **Project Directory (`cwd`) & Agent Profile (`--agent`):**
  - เพิ่ม `cwd` picker (recent projects / path input) และ optional `agentProfile?: string` (ส่ง `--agent <name>` ตอน spawn) เวลาสร้าง session ใหม่ เพื่อให้ 1 Web UI คุมงานข้ามหลายโปรเจคและหลาย role ได้
- **Mid-Session Model Switch & Slash Commands:**
  - เปลี่ยน model กลาง session ด้วยการส่ง `/model <name>` เข้า `tmux` (ไม่ต้องเปิด session ใหม่)
  - รองรับส่ง slash commands ยอดนิยมจาก UI (`/compact`, `/clear`, `/cost`) และ `@file` autocomplete จาก workspace (`GET /api/workspace/files`)
- **Image / Screenshot Paste Input:**
  - `POST /api/chat/upload` (หรือ paste รูปจาก clipboard บนเว็บ) บันทึกรูปลง temp file ใน workspace/cache แล้วแนบ path เข้า prompt ของ CLI (`tmux`) ให้ agent อ่านภาพได้

## 3. Exit Criteria / Verification

1. เมื่อ `claude` ติด permission prompt, `PermissionRequest` hook hold รอคำตัดสินจากหน้าเว็บ → กด Allow/Deny แล้วทำงานต่อได้โดยไม่ค้าง (และหากเว็บไม่เปิดอยู่ hook ต้อง fallback กลับสู่ TUI ภายใน timeout)
2. เมื่อ `claude` เรียก `AskUserQuestion` (single/multi-select), หน้าเว็บแสดงตัวเลือกจาก `.jsonl` และส่ง keystrokes เข้า `tmux` เพื่อตอบจนผ่านได้
3. เปิด `claude` ใน terminal ภายนอก → หน้าเว็บมองเห็น session ใน list และโหลดประวัติจาก `.jsonl` ได้ถูกต้อง
4. กด Resume session เก่าจากประวัติ `.jsonl` แล้วเปิด `tmux` ต่อบทสนทนาเดิมได้
5. สามารถสลับสร้าง session แบบเลือก `cwd` ต่างกัน, ระบุ `agentProfile`, สั่ง `/model` หรือ `/compact` กลาง session, และใช้ `ANTHROPIC_API_KEY` (isolated env ใน `tmux new-session -e`) โดยไม่กระทบ global CLI login ของเครื่อง
