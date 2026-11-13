# Phase 8: Sequential Sub-Agent Playwright E2E Full Test (`agy` & `opencode`) + UX Issue Triage

> **Status:** ✅ Executed (8/8 Groups Audited — 31 Issues Logged in `ai-dev-docs/issue/`)  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 5](./phase-05-multi-harness-adapters.md), [Phase 6](./phase-06-canonical-session-and-sync.md), [Phase 7](./phase-07-ui-polish-boundaries-packaging.md)  
> **Workflow Rules:** [AGENT.md](../../AGENT.md)

---

## 1. Objective

วางแผนและดำเนินการทดสอบ **End-to-End (E2E) Full Test** ผ่านเบราว์เซอร์จริงด้วย **Playwright (Chromium)** ให้ใกล้เคียงการใช้งานจริงของผู้ใช้มากที่สุด โดยโฟกัสที่ 2 harnesses ก่อน ได้แก่ **Antigravity CLI (`agy`)** และ **OpenCode (`opencode`)**

นอกจากตรวจว่าโค้ด "ทำงานได้ไม่พัง" แล้ว การทดสอบนี้ต้องทำ **UX / Usability Audit** ไปพร้อมกัน หากพบปัญหาใด ๆ (เช่น ใช้งานยาก, งง, flow สับสน, feedback ช้าหรือไม่ชัดเจน, layout เพี้ยน, error ไม่สื่อความหมาย) ต้องบันทึกแยกเป็นไฟล์ลงใน `ai-dev-docs/issue/` ทันทีแบบ **1 ไฟล์ต่อ 1 ปัญหา**

---

## 2. Execution Architecture: Sequential Sub-Agent (ทีละ 1 ตัว)

```text
Coordinator (Main Agent)
  ├─ Step 0: Pre-flight & Isolated Test Env (Temp Git Repo + HARNESS_WEB_HOME + Server)
  ├─ Step 1: Spawn Sub-agent #1 (Group 1) ──▶ Run Playwright + Audit UX ──▶ Log Issues ──▶ Cleanup
  ├─ Step 2: Spawn Sub-agent #2 (Group 2) ──▶ Run Playwright + Audit UX ──▶ Log Issues ──▶ Cleanup
  ├─ ... (ทำทีละ 1 ตัวตามลำดับ รอตัวก่อนหน้าจบและ cleanup ก่อนเสมอ)
  ├─ Step 8: Spawn Sub-agent #8 (Group 8) ──▶ Run Playwright + Audit UX ──▶ Log Issues ──▶ Cleanup
  └─ Step 9: Final Report (สรุปผลทุก Flow + ดัชนีไฟล์ใน ai-dev-docs/issue/)
```

### เหตุผลที่ต้อง Spawn Sub-agent ทีละ 1 ตัว
1. **ป้องกัน Shared State ชนกัน:** Backend ใช้ `HARNESS_WEB_HOME`, SQLite canonical store, `tmux` sessions, `opencode serve` ports, และ Git worktree บน workspace เดียวกัน
2. **แยก Context ชัดเจน:** Sub-agent แต่ละตัวโฟกัสเฉพาะ UI Flow Group ของตัวเอง ทำให้ตรวจสอบ DOM, SSE events, network requests และ UX friction ได้ละเอียด
3. **เกณฑ์ Pass/Fail มาตรฐานเดียวกันทุกตัว:**
   - Fail หากพบ `pageerror`, `console.error`, หรือ HTTP response `>= 500`
   - เก็บ Screenshot + Playwright Trace (`trace.zip`) + Console/Network log ทุกครั้งที่พบปัญหา

---

## 3. Pre-flight & Environment Setup

### 3.1 สถานะเครื่องปัจจุบัน (ตรวจพบล่าสุด)
- **พร้อมใช้งาน:** `bun`, `agy` (`/home/korarit/.gemini/bin/agy`), Chromium cache ของ Playwright (`~/.cache/ms-playwright/chromium-1228`)
- **สิ่งที่ต้องเตรียมก่อนรัน Real Binary Mode:**
  - ติดตั้ง `playwright` (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) สำหรับรัน script
  - ติดตั้ง `tmux` บนเครื่อง (`sudo apt update && sudo apt install -y tmux`) เพื่อให้ `AntigravityHarnessAdapter` รัน `agy` แบบ interactive และเปิดแท็บ `Terminal` ได้
  - เตรียม `opencode` binary ใน `PATH` หรือชี้ `OPENCODE_SERVER_URL` ไปยัง OpenCode server ที่รันอยู่

### 3.2 การแยก Environment เพื่อไม่ให้กระทบข้อมูลจริง
- Build frontend ล่าสุดก่อนเริ่ม: `bun run build`
- รันเซิร์ฟเวอร์ทดสอบบนพอร์ตแยก (เช่น `127.0.0.1:3199`) พร้อม env แยกใน [env.ts](../../apps/api/src/env.ts):
  - `HARNESS_WEB_HOME=/tmp/e2e-harness-web`
  - `AGY_CLI_HOME=/tmp/e2e-agy-cli` (หรือผูกกับ config จริงหากต้องการทดสอบ credentials เดิม)
  - `OPENCODE_DATA_HOME=/tmp/e2e-opencode-data`
- สร้าง **Temp Git Repo** (`/tmp/e2e-git-workspace`) พร้อม initial commit สำหรับให้ agent แก้ไฟล์, ทดสอบ Diff/Revert และ Git Worktree Lifecycle

### 3.3 โหมดการรัน (รอผู้ใช้เลือกก่อนลงมือ)
- **Option A — Real CLI E2E 100%:** ใช้ `tmux` + `agy` + `opencode` จริงทุกขั้นตอน
- **Option B — Hybrid / Local Stub E2E:** กรณียังไม่มี `tmux` หรือ `opencode` ให้สร้าง local stub (`tmux` shim + OpenCode mock HTTP/SSE server ผ่าน `OPENCODE_SERVER_URL`) เพื่อทดสอบ UI/API/UX flow ทั้งหมดใน Playwright ก่อน

---

## 4. Test Groups แบ่งตาม UI Flow (8 Sub-agents)

| ลำดับ | Flow Group | Components หลักที่ทดสอบ | Checklist การทดสอบเสมือนใช้งานจริง |
| :---: | :--- | :--- | :--- |
| **1** | **Boot, Health, Responsive & Global Controls** | `WorkspacePage`, `DesktopShell`, `CompactShell`, `CommandPalette`, `ThemeSwitcher`, `SoundToggle` | • ตรวจ `/api/health` และ `/api/harnesses` แสดง `agy` และ `opencode`<br>• ทดสอบ Desktop (`1440x900`) vs Mobile/Compact (`390x844`: drawer + bottom tabs)<br>• สลับ Theme (`system`/`light`/`dark`), Mute sound, เปิด Command Palette (`Ctrl+K`) |
| **2** | **New Session Composer & Input Autocomplete** | `ChatPanel`, `HarnessPicker`, `ContextBar` | • สลับ `Antigravity CLI` vs `OpenCode` ใน composer -> ตรวจ model list, auth mode, agent profile, CWD selector<br>• ทดสอบ `/` slash commands (`/compact`, `/clear`, `/cost`, `/model ...`)<br>• ทดสอบ `@` file mention autocomplete และ image paste/upload |
| **3** | **`agy` Live Session & Interactive Controls** | `ChatPanel`, `InteractionCard`, `TaskTimeline`, `ToolCallBlock`, `HarnessBadge` | • ส่ง prompt แรก -> ตรวจ URL `/sessions/:id`, badge Antigravity, streaming text, Markdown, ToolCallBlock, token usage<br>• ทดสอบ Permission card (`Allow` / `Allow Always` / `Deny`) และ Question card<br>• ทดสอบ `Abort` ระหว่างรัน และ `Resume` / `Continue in Web` |
| **4** | **`opencode` Live Session & Interactive Controls** | `ChatPanel`, `InteractionCard` | • ส่ง prompt แรกด้วย `opencode` -> ตรวจ running banner (ไม่มี tmux), SSE streaming (`message.part.updated`), Tool calls<br>• ทดสอบ REST Permission/Question reply ผ่าน UI<br>• ทดสอบ follow-up turns, `Abort`, และ reload หน้าเพื่อยืนยัน persistence |
| **5** | **Cross-Harness Switch & Canonical Sync (`agy` ⇄ `opencode`)** | `ChatPanel`, `CommandPalette` | • เริ่มคุยบน `agy` 1–2 เทิร์น -> สลับไป `opencode` (ทั้งจาก Header และ `Ctrl+K`)<br>• ตรวจ `harness_switched` divider บน timeline (ต้นทาง/ปลายทาง, จำนวนเทิร์น, strategy)<br>• ถามต่อบน `opencode` อ้างอิงบริบทเดิม แล้วสลับกลับ `agy` เพื่อตรวจว่าไม่ซ้ำเทิร์น |
| **6** | **Sidebar, External Discovery & Session Lifecycle** | `SessionSidebar`, `ConfirmDeleteModal` | • ตรวจ external sessions (`mirror` badge) ของ `agy` และ `opencode` + ปุ่ม `Continue in Web`<br>• ทดสอบ Filters (`harness`, `origin`, `cwd`, `q`)<br>• ทดสอบ Rename, Archive / Unarchive (สลับ Active/Archived), และ Delete พร้อม confirm modal |
| **7** | **Inspector: Changes/Diff, Agent Board & Terminal** | `ChangesPanel`, `DiffViewer`, `AgentBoard`, `TerminalPanel` | • **Changes:** แก้ไฟล์ใน temp repo -> ตรวจ `Session` vs `Git` mode, `Unified`/`Split`/`Raw` view, contributor filter, และ `Revert`<br>• **AgentBoard:** ตรวจ subagent (`invoke_subagent` / `parentID`) -> สลับ `Grid`/`Activity`, drill-down `/sessions/:id/agents/:agentId` แล้ว `Back to main`<br>• **Terminal (`agy`):** เปิดแท็บ `Terminal`, ตรวจ WS capture, ปุ่ม `Tab`/`Esc`/`Ctrl+C`/`Up`/`Down`/`Enter`, ส่งคำสั่ง, Copy `tmux attach` |
| **8** | **Git Worktree Lifecycle** | `WorktreeModal`, `ChangesPanel` | • เปิด Worktree Modal สร้าง branch/worktree ใหม่บน temp repo<br>• เลือก worktree เพื่อเริ่ม session ใหม่ -> แก้ไฟล์ -> กด `Review Diff`<br>• ทดสอบ `Merge` (with `removeAfterMerge`) และ `Remove` worktree ยืนยัน CWD กลับไปที่ repo root |

---

## 5. กฎการบันทึกปัญหาลง `ai-dev-docs/issue/` (Mandatory Issue Logging)

ระหว่างการทดสอบทุก Group ทั้ง Coordinator และ Sub-agent ต้องสังเกต **ทั้งบั๊กเชิงเทคนิคและปัญหา UX/ความเข้าใจยาก** เช่น:
- ใช้งานยาก ต้องคลิกหลายขั้นเกินจำเป็น หรือหาปุ่มไม่เจอ
- ข้อความบน UI, label, tooltip, error message, หรือ state transition ชวนให้งง / สับสน
- ไม่มี loading/feedback ที่ชัดเจนเมื่อรอ harness ตอบ หรือรอ switch harness
- ปัญหา layout ล้น/บังกันใน Desktop หรือ Compact/Mobile view
- บั๊กการทำงานของ API, SSE, WebSocket, adapter หรือ state ค้าง

### รูปแบบการบันทึก (อ้างอิง [AGENT.md §1.2](../../AGENT.md))
1. **1 ไฟล์ต่อ 1 ปัญหาเท่านั้น** (ห้ามรวมหลายปัญหาไว้ในไฟล์เดียว)
2. **ตำแหน่งไฟล์:** `ai-dev-docs/issue/`
3. **ชื่อไฟล์:** `YYYYMMDD-<issue-name-kebab-case>.md` (ใช้ UTC date เช่น `20261113-confusing-harness-switch-disabled-tooltip.md`)
4. **ตรวจสอบไฟล์เดิมก่อนเขียน:** ถ้าเป็นปัญหาเดียวกันเป๊ะที่เคยบันทึกแล้วในรอบก่อนหน้า ให้แนบหลักฐานเพิ่มเติมในไฟล์เดิมแทนการสร้างซ้ำ
5. **โครงสร้างขั้นต่ำในแต่ละไฟล์:**
   - **1. Problem Statement / Reproduction:** ระบุ Group ที่พบ, Harness (`agy` / `opencode` / `both`), ประเภท (`ux-confusing` / `ux-hard-to-use` / `bug` / `error-handling` / `setup`), ขั้นตอนการทำซ้ำ, พฤติกรรมที่เจอ vs ที่คาดหวัง, และ path ของ Screenshot / Trace
   - **2. Root Cause Hypothesis:** ระบุไฟล์ component / route / adapter ที่คาดว่าเป็นต้นเหตุ
   - **3. Proposed Fix(es):** แนวทางแก้ไข (หากจะลงมือแก้โค้ดให้เสนอ 3 options + recommended ตาม `AGENT.md §3`)
   - **4. File-Level Change Plan:** รายชื่อไฟล์ที่คาดว่าจะแก้
   - **5. Test / Verification Plan:** วิธีตรวจซ้ำด้วย Playwright หรือ unit/integration test หลังแก้

---

## 6. Exit Criteria

1. Sub-agent ทั้ง 8 Groups ถูกรันครบตามลำดับ **ทีละ 1 ตัว** และรายงานผลครบทุกฟีเจอร์สำหรับ `agy` และ `opencode`
2. ปัญหาทุกข้อที่พบ (บั๊ก + ความงง/ใช้งานยาก) ถูกบันทึกเป็นไฟล์แยกใน `ai-dev-docs/issue/` แบบ **1 ไฟล์ต่อ 1 ปัญหา** ครบถ้วน
3. ไม่มีไฟล์หรือ git worktree ขยะค้างอยู่ใน workspace หลังจบการทดสอบ
