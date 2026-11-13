# Phase 4: Multi-Agent Visibility & Worktree Dashboard

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 2](./phase-02-interactive-controls-and-discovery.md), [Phase 3](./phase-03-code-preview-and-file-changes.md)

## 1. Objective

ทำให้หน้าเว็บมองเห็นการทำงานของ **Subagents** และ **Claude Code Agent Teams** แบบแยกตัวตนชัดเจน (ดูสถานะแต่ละตัวว่ากำลังอ่าน/แก้/รันเทสต์/รออะไรอยู่, คลิกเข้าไปดู stream ตัวลูกแล้วสลับกลับ Main ได้) พร้อมการแยก **Git Worktree** ต่อ session/agent เพื่อไม่ให้งานขนานแก้ไฟล์ชนกัน

## 2. Scope & Detailed Tasks

### 4.1 Subagent & Agent Team Telemetry Model
- **แหล่งข้อมูล (Read-only observation):**
  - Hook `SubagentStart` / `SubagentStop` ที่ส่ง `agent_id`, `agent_type`, และ **`agent_transcript_path`** (`agent-{agentId}.jsonl`) → เปิด `jsonl-watcher` tail ไฟล์ของ subagent ตัวนั้นแบบ real-time แยกจากไฟล์หลัก
  - `.jsonl` transcripts ของ main session (อ้างอิง `parent_tool_use_id`, `Task` / `Agent` tool calls) + Hooks `TeammateIdle`, `TaskCreated`, `TaskCompleted`
  - Task files ของ Claude Code Agent Teams ใน `~/.claude/tasks/<team-or-session>/`
- **Backend Endpoint:**
  - `GET /api/chat/sessions/:id/agents` → รายการ `AgentNode` ใน session นั้น (Main + Subagents / Teammates)
  - `GET /api/chat/sessions/:id/agents/:agentId/events` → SSE stream เฉพาะ transcript ของ subagent ตัวนั้น (replay + live tail)
- **Contracts (`packages/contracts`):**
  - เพิ่ม `AgentNode` (`agentId`, `parentAgentId?`, `role`, `transcriptPath?`, `canSendInput: boolean`, `state: "thinking" | "reading" | "editing" | "running_cmd" | "waiting" | "idle" | "done"`, `currentTool?`, `currentTarget?`, `usage`)
  - เพิ่ม `TeamTaskItem` (`id`, `subject`, `owner?`, `status: "pending" | "in_progress" | "completed"`)

### 4.2 Visual Multi-Agent Views & Subagent Drill-Down (`apps/web`)
- **Subagent Tree ใน `SessionSidebar`:**
  - แสดงรายการลูก (`↳ Codebase Researcher`, `↳ Test Runner`) แบบ Tree ใต้ Session แม่ทันทีเมื่อมีการ spawn subagent
  - แสดง **loading spinner icon** แยกต่อ subagent ตัวที่กำลังรันอยู่ (`done ✓` เมื่อจบ)
- **Subagent Drill-Down & Switch Back to Main (URL Resource Route):**
  - คลิก subagent จาก Tree ใน Sidebar หรือจาก Agent Card เพื่อเปลี่ยน resource URL เป็น `/sessions/:id/agents/:agentId` และ **สลับหน้าแชทเข้าไปอ่านการทำงานของ subagent ตัวนั้นแบบ real-time** (เห็น thinking, tool calls, ผลลัพธ์ทั้งหมดของตัวลูก; แสดง banner `Read-only Inspector` สำหรับ subagent ที่ถูกคุมโดยตัวแม่)
  - มีปุ่ม **`← Back to Main`** (หรือกด Back บน browser / คลิกตัวแม่ใน Sidebar) เพื่อสลับกลับมา `/sessions/:id` ได้ทันทีโดยไม่ขัดจังหวะการทำงานของทั้ง Main และ Subagent
- **Agent Swimlanes / Grid View (`AgentBoard`):**
  - การ์ดต่อ 1 agent แสดงสถานะปัจจุบัน, tool ล่าสุด, token ที่ใช้, และ mini-log ของ agent ตัวนั้น
  - จัดวางบน `DesktopShell` (`>= 1280px`) เป็น Split/Modal View และบน `CompactShell` (`< 1280px`) เป็น Tab `Agents` เต็มจอ (single-column cards)
- **Task Board Sync:**
  - แสดง Shared Task List (`TodoWrite` + `~/.claude/tasks/`) แบบ Kanban/Checklist sync ตาม real-time
- **Visual Activity View (Optional / Toggleable):**
  - แสดงตัวละคร/avatar ตามสถานะ (`reading`, `editing`, `bash`, `waiting`, `idle`) เพื่อให้กวาดตาดูได้ทันทีว่ามี agent ตัวไหนติดค้างหรือเสร็จแล้ว

### 4.3 Git Worktree Isolation & Per-Worktree Diff Review
- **Backend (`apps/api` — bounded context `workspace` เชื่อมต่อกับ Diff Viewer จาก Phase 3):**
  - List worktrees (`git worktree list --porcelain`)
  - Create worktree (`git worktree add <path> -b <branch>`) ก่อนเปิด session/agent ใหม่
  - Reuses Phase 3 `Changes / Diff` engine บน `worktree.path` ของแต่ละ session/agent (แยก branch diff ออกจากกัน 100%)
  - Cleanup/merge helper (ให้ผู้ใช้กด review diff ใน Diff Viewer แล้วสั่ง merge/remove worktree เองอย่างปลอดภัย)
- **Frontend:**
  - Modal เลือก branch / สร้าง worktree ใหม่เวลาเริ่ม session
  - เปิด `ChangesDrawer` จาก Phase 3 แยกดู diff ของแต่ละ worktree / แต่ละ `agentId`

## 3. Exit Criteria / Verification

1. เมื่อ Claude แตก Subagents 2–3 ตัวหรือใช้ Agent Teams หน้าเว็บแสดงรายการลูกใน `SessionSidebar` (พร้อม loading icon) และการ์ดแยกตาม `agentId` พร้อมอัปเดตสถานะ `reading` / `editing` / `idle` ได้ตรงตามจริง
2. คลิกเข้าไปดูการทำงานสดๆ ของ Subagent ตัวใดตัวหนึ่งจาก Sidebar/Card แล้วกด **`← Back to Main`** สลับกลับมาดู Main Session ได้ต่อเนื่องโดยไม่ขัดจังหวะการทำงาน
3. Shared Task List อัปเดตสถานะ `pending -> in_progress -> completed` ตามการทำงานจริงโดยไม่ต้องรีเฟรชหน้า
4. สร้าง session บน git worktree แยก 2 ตัวพร้อมกัน → แก้ไฟล์คนละ branch ไม่ชนกัน → ดู diff ของแต่ละ worktree บน `ChangesDrawer` ได้
