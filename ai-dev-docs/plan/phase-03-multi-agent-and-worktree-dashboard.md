# Phase 3: Multi-Agent Visibility & Worktree Dashboard

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 2](./phase-02-interactive-controls-and-discovery.md)

## 1. Objective

ทำให้หน้าเว็บมองเห็นการทำงานของ **Subagents** และ **Claude Code Agent Teams** แบบแยกตัวตนชัดเจน (ดูสถานะแต่ละตัวว่ากำลังอ่าน/แก้/รันเทสต์/รออะไรอยู่) พร้อมการแยก **Git Worktree** เพื่อไม่ให้งานขนานแก้ไฟล์ชนกัน

## 2. Scope & Detailed Tasks

### 3.1 Subagent & Agent Team Telemetry Model
- **แหล่งข้อมูล (Read-only observation):**
  - `.jsonl` transcripts ของ main session และ subagent transcripts (อ้างอิง `parent_tool_use_id`, `Task` / `Agent` tool calls)
  - Hooks: `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`
  - Task files ของ Claude Code Agent Teams ใน `~/.claude/tasks/<team-or-session>/`
- **Contracts (`packages/contracts`):**
  - เพิ่ม `AgentNode` (`agentId`, `parentAgentId?`, `role`, `state: "thinking" | "reading" | "editing" | "running_cmd" | "waiting" | "idle" | "done"`, `currentTool?`, `currentTarget?`, `usage`)
  - เพิ่ม `TeamTaskItem` (`id`, `subject`, `owner?`, `status: "pending" | "in_progress" | "completed"`)

### 3.2 Visual Multi-Agent Views (`apps/web`)
- **Agent Swimlanes / Grid View:**
  - การ์ดต่อ 1 agent แสดงสถานะปัจจุบัน, tool ล่าสุด, token ที่ใช้, และ mini-log ของ agent ตัวนั้น (คลิกเข้าไปดูข้อความเต็มได้)
- **Task Board Sync:**
  - แสดง Shared Task List (`TodoWrite` + `~/.claude/tasks/`) แบบ Kanban/Checklist sync ตาม real-time
- **Visual Activity View (Optional / Toggleable):**
  - แสดงตัวละคร/avatar ตามสถานะ (`reading`, `editing`, `bash`, `waiting`, `idle`) เพื่อให้กวาดตาดูได้ทันทีว่ามี agent ตัวไหนติดค้างหรือเสร็จแล้ว

### 3.3 Git Worktree Isolation & Diff Review
- **Backend (`apps/api` — bounded context ใหม่ `workspace` หรือ sub-module ใน `worktree`):**
  - List worktrees (`git worktree list --porcelain`)
  - Create worktree (`git worktree add <path> -b <branch>`) ก่อนเปิด session/agent ใหม่
  - Inspect diff (`git status --short`, `git diff --stat`, `git diff <file>`)
  - Cleanup/merge helper (ให้ผู้ใช้กด review diff แล้วสั่ง merge/remove worktree เองอย่างปลอดภัย)
- **Frontend:**
  - Modal เลือก branch / สร้าง worktree ใหม่เวลาเริ่ม session
  - Diff drawer แสดงไฟล์ที่ agent แก้ไขใน worktree นั้น

## 3. Exit Criteria / Verification

1. เมื่อ Claude แตก Subagents 2–3 ตัวหรือใช้ Agent Teams หน้าเว็บแสดงการ์ดแยกตาม `agentId` และอัปเดตสถานะ `reading` / `editing` / `idle` ได้ตรงตามจริง
2. Shared Task List อัปเดตสถานะ `pending -> in_progress -> completed` ตามการทำงานจริงโดยไม่ต้องรีเฟรชหน้า
3. สร้าง session บน git worktree แยก 2 ตัวพร้อมกัน → แก้ไฟล์คนละ branch ไม่ชนกัน → ดู diff ของแต่ละ worktree บนหน้าเว็บได้
