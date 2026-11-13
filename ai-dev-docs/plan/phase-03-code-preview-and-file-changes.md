# Phase 3: Session Code Preview, File Changes & Diff Viewer

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 2](./phase-02-interactive-controls-and-discovery.md)

## 1. Objective

ให้ผู้ใช้ตรวจสอบไฟล์ที่ถูกแก้ไข/สร้าง/ลบภายในแต่ละ Session แบบ real-time พร้อม **Code Preview & Diff Viewer** (Unified / Side-by-Side) ได้ทันทีจากหน้าเว็บ โดยแยกดูได้ทั้ง **เฉพาะไฟล์ที่ Session นั้นแตะต้อง** (แม้เปิดหลาย session ใน repo เดียวกัน) และ **Workspace Git Diff** ทั้งหมด

## 2. Two-Layer Change Tracking Design

1. **Session-Scoped File Changes (`session_tool`):**
   - เมื่อเปิดหลาย session ในโฟลเดอร์/branch เดียวกัน การรัน `git diff` อย่างเดียวจะเห็นไฟล์ปนกันทุก session
   - ระบบจึงดักจับ `PreToolUse` / `PostToolUse` hooks และ `.jsonl` tool calls (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) เพื่อเก็บ **before-snapshot** (เฉพาะครั้งแรกที่ session แตะไฟล์นั้น) และคำนวณ diff เฉพาะของ session นั้นๆ แยกตาม `sessionId` (และ `agentId` ถ้าเป็น subagent)
2. **Workspace Git Diff (`git_workspace`):**
   - ครอบคลุมการแก้ไขไฟล์ทางอ้อมผ่าน `Bash` (เช่น `sed`, codegen, `rm`, `mv`, package install) ด้วย `git status --porcelain` และ `git diff` ใน `cwd` ของ session (และใน Phase 4 เมื่อแยก Git Worktree จะแยก diff ต่อ session ได้ 100%)

## 3. Detailed Tasks

### 3.1 Contracts (`packages/contracts`)
- สร้าง `src/changes.ts` (หรือขยาย `chat.ts`):
  - `FileChangeStatus = "added" | "modified" | "deleted" | "renamed"`
  - `SessionFileChange`: `{ path, status: FileChangeStatus, additions: number, deletions: number, source: "session_tool" | "git_workspace", lastUpdatedAt: string, agentId?: string }`
  - `FileDiffResponse`: `{ path, status, mode: "session" | "git", originalText: string | null, modifiedText: string | null, unifiedDiff: string, isBinary: boolean, truncated: boolean }`
- เพิ่ม `"file_changed"` ใน `ChatEventType` สำหรับแจ้ง UI แบบ real-time

### 3.2 Backend (`apps/api` — bounded context `workspace` / `changes` หรือ sub-module)
- **Snapshot & Diff Service:**
  - `PreToolUse` (สำหรับ tool แก้ไฟล์): บันทึก baseline content ของไฟล์ (ถ้ายังไม่เคยบันทึกใน session) ลง `~/.harness-web/snapshots/<sessionId>/`
  - `PostToolUse` / `.jsonl` parser: คำนวณ `+additions / -deletions` และ emit `"file_changed"` เข้า `EventBusPort` ของ session
  - Path security: normalize และบังคับ `resolvedPath` ให้อยู่ภายใต้ `session.cwd` เสมอ (กัน `../` traversal และ symlink escape)
- **Endpoints:**
  - `GET /api/chat/sessions/:id/changes` → คืนรายการ `SessionFileChange[]` + summary (`filesCount`, `totalAdditions`, `totalDeletions`)
  - `GET /api/chat/sessions/:id/changes/diff?path=<relPath>&mode=session|git` → คืน `FileDiffResponse` (รองรับ binary check และ size cap)
  - `GET /api/chat/sessions/:id/files/raw?path=<relPath>` → อ่านไฟล์เต็มสำหรับ Code Preview
  - `POST /api/chat/sessions/:id/changes/revert` → ย้อนเฉพาะไฟล์กลับไปที่ before-snapshot ของ session (หรือ `git checkout -- <path>`) พร้อมตรวจ path safety

### 3.3 Frontend (`apps/web`)
- **`ChangesDrawer` / Split Panel (Right-side Drawer หรือ Tab `Changes (N)`):**
  - แสดงรายชื่อไฟล์ที่เปลี่ยนพร้อม badge (`M`, `A`, `D`, `R`) และตัวเลข `+N / -M`
  - Toggle สลับโหมดดู **Session Changes** (เฉพาะไฟล์ที่ session นี้แก้) กับ **All Git Changes** (`git status`/`git diff`)
  - **Diff Viewer:** สลับระหว่าง **Unified Diff** กับ **Side-by-Side Diff** พร้อม syntax highlighting, line numbers, ปุ่ม Copy path/code, ปุ่ม View Full File และปุ่ม Revert (มี confirm modal)
- **Inline File Pills ใน `ChatView.tsx`:**
  - ข้อความ/tool block ที่แก้ไฟล์ (เช่น `Edited src/app.ts (+12 -3)`) คลิกแล้วเปิด `ChangesDrawer` กระโดดไปไฟล์นั้นทันที

## 4. Exit Criteria / Verification

1. Session แก้ไขหรือสร้างไฟล์ผ่าน `Edit`/`Write` → badge `Changes (N)` และรายการไฟล์อัปเดตทันทีผ่าน SSE โดยไม่ต้องรีเฟรชหน้า
2. เปิด 2 sessions ใน repo เดียวกันแก้คนละไฟล์ → โหมด `Session Changes` ของแต่ละห้องแสดงเฉพาะไฟล์ที่ session ตัวเองแก้ ไม่ปนกัน
3. คลิกไฟล์ใน drawer หรือ pill ในแชท → preview โค้ดแบบ Unified / Side-by-Side diff และดูไฟล์เต็มได้ถูกต้อง (ทดสอบ path traversal `../` ต้องถูก reject `400/403`)
4. Agent แก้ไฟล์ผ่าน `Bash` (เช่น `echo ... > file`) → โหมด `All Git Changes` แสดงการเปลี่ยนแปลงได้ครบ
