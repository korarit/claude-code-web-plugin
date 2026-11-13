# Phase 5: Canonical Session Store & Full-Verbatim Cross-Harness Sync

> **Status:** 📋 Planned  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 4](./phase-04-multi-harness-adapters.md)

## 1. Objective

ทำให้การสลับ harness กลางบทสนทนาระหว่าง **Claude CLI ↔ Antigravity CLI (`agy`) ↔ OpenCode** **ประสาน Session ได้แบบไร้รอยต่อ โดยไม่พึ่งการสรุปย่อ (no lossy handoff summary)** เพื่อไม่ให้รายละเอียดที่คุยไปแล้วตกหล่นหรือลืม

หลักการ: **ระบบเราเก็บ Full Verbatim History ไว้เองเป็น Canonical Store** และส่งประวัติตัวเต็ม (เฉพาะส่วนที่ harness ปลายทางยังไม่เคยเห็น) เข้าไปอย่างแนบเนียนตอนสลับ

## 2. Core Design: Canonical Session + Lazy Full-Verbatim Delta Sync

```text
[Canonical Session Store (SQLite / JSONL ของระบบเราเอง)]
  ├── canonicalSessionId
  ├── activeHarness: "claude" | "agy" | "opencode"
  ├── canonicalEvents[]: [ { seq: 1, role, content, toolCalls, toolResults, filesTouched, ts }, ... ]
  └── bindings:
        ├── claude:   { sessionId, tmuxSession, transcriptPath, lastSyncedSeq: 5 }
        ├── agy:      { conversationId, tmuxSession, transcriptPath, lastSyncedSeq: 8 }
        └── opencode: { sessionId, serverUrl/tmuxSession, lastSyncedSeq: 0 }
```

### กฎการทำงาน 3 ข้อ (Zero-Loss & No-Duplicate)
1. **ห้ามสรุปทิ้ง:** ทุก turn ที่เกิดจาก `claude`, `agy`, หรือ `opencode` จะถูก normalize และบันทึก **ข้อความตัวเต็ม + tool outputs สำคัญ** ลง `canonicalEvents[]` พร้อมเลข `seq` เพิ่มขึ้นเรื่อยๆ
2. **Lazy Sync on Next Prompt (ไม่ยิงเปล่าตอนกดสลับ):**
   - เมื่อผู้ใช้กดสลับ harness บน UI (เช่น `claude` → `agy`) ระบบเปลี่ยน `activeHarness` และเตรียม binding ไว้เฉยๆ (ยังไม่ยิง prompt เปล่า)
   - เมื่อผู้ใช้พิมพ์คำสั่งถัดไป ระบบจึงคำนวณ **Unsynced Delta** = `canonicalEvents` ตั้งแต่ `target.lastSyncedSeq + 1` จนถึง `latest` แล้วส่งเข้าไปพร้อมคำสั่งใหม่ในครั้งเดียว
3. **จำ Cursor แยกเจ้า (`lastSyncedSeq`):**
   - ถ้าสลับ `Claude (1..5)` → `AGY (6..8)` → กลับมา `Claude (9)`:
     - Session เดิมของ Claude ยังอยู่ (`--resume` / `tmux`) และจำ `1..5` ได้แล้ว
     - ระบบจะส่งเข้าไปให้ Claude **เฉพาะ verbatim turns `6..8` (ช่วงที่ AGY ทำไป)** ไม่ส่ง `1..5` ซ้ำ!

## 3. Injection Strategies (วิธีส่งประวัติเต็มเข้าแต่ละ Harness)

### 3.1 Direct Verbatim Injection (ค่าเริ่มต้น — ใช้ได้ทุกขนาดปานกลาง)
- ประกอบก้อน Verbatim Transcript ของช่วง `[lastSyncedSeq + 1 .. latest]` (ครบทุกคำตอบ, file paths, error logs, decisions)
- ส่งผ่าน `tmux load-buffer` + `paste-buffer` (สำหรับ `claude` / `agy`) หรือ OpenCode message API (สำหรับ `opencode`) แนบนำหน้าคำสั่งใหม่ของผู้ใช้ในรูปแบบที่มีโครงสร้างชัดเจน
- อัปเดต `target.lastSyncedSeq = latest` ทันทีหลังส่งสำเร็จ

### 3.2 Large-History File Sync Fallback & Context Window Guard
- ถ้าขนาด Verbatim Delta เกิน threshold (เช่น `> 20 KB` หรือเกิน `N` turns) **หรือใกล้เกิน Context Window Limit ของโมเดลปลายทาง** (เช่น สลับจากโมเดล 1M context ไปยังโมเดล 128k/200k):
  - เขียนไฟล์เต็มไว้ที่ `.harness-web/sync/<canonicalSessionId>-<fromSeq>-<toSeq>.md` (เก็บทุกบรรทัด 100% ไม่ตัดทอน)
  - แสดง warning badge บน UI (`Large context — using File Sync`) แล้วส่งเฉพาะ verbatim ช่วงล่าสุด (เช่น 5–10 turns สุดท้าย) เข้าไปตรงๆ + แนบคำสั่งให้ harness ปลายทางอ่านไฟล์ `.harness-web/sync/...md` เฉพาะส่วนที่ต้องการ เพื่อไม่ให้ prompt ระเบิดเพดาน context window ของโมเดลปลายทาง

### 3.3 Optional Native DB Injection สำหรับ OpenCode (`opencode import`)
- สำหรับ `opencode` ที่มีคำสั่ง `opencode import <json>` อย่างเป็นทางการ:
  - รองรับการแปลง `canonicalEvents` เป็น OpenCode JSON tree แล้ว `opencode import` เข้า `opencode.db` ก่อนเปิด `-s <id>` เพื่อให้ OpenCode เห็นประวัติเป็น native turns ของตัวเอง 100%

## 4. Detailed Tasks

### 4.1 Persistence (`apps/api` — `session` / `sync` store)
- เพิ่ม persistent store (SQLite ผ่าน `bun:sqlite` หรือ append-only JSONL ใน `~/.harness-web/sessions/`) สำหรับเก็บ `CanonicalSession`, `canonicalEvents[]`, และ `bindings` (ทนต่อการ restart server)
- สร้าง `CanonicalEventNormalizer` แปลง event ของ `claude`, `agy`, `opencode` ให้เป็น `CanonicalEvent` กลางที่มี `seq`, `harnessId`, `role`, `text`, `toolCalls[]` (เก็บเฉพาะ input/output ที่จำเป็นครบถ้วนโดยไม่ตัดใจความสำคัญ)

### 4.2 Application Usecases (`apps/api`)
- `SwitchHarnessUsecase`: ตรวจ availability ของ target harness, อัปเดต `activeHarness`, บันทึก switch marker event (`harness_switched`)
- `SendWithSyncUsecase` (ต่อยอดจาก `SendMessageUsecase`):
  - คำนวณ `delta = events.filter(e => e.seq > binding.lastSyncedSeq)`
  - เลือกกลยุทธ์ Direct Verbatim / File Fallback / Native Import
  - ส่งเข้า target harness adapter และอัปเดต `binding.lastSyncedSeq`

### 4.3 Frontend (`apps/web`)
- **In-Chat Harness Switcher:** Dropdown สลับระหว่าง `Claude CLI` / `Antigravity` / `OpenCode` ได้กลาง thread เดิมทันที
- **Unified Timeline:** แสดงประวัติการคุยทั้งหมดต่อเนื่องเป็นห้องแชทเดียว ไม่กระโดดหายเวลาเปลี่ยนเจ้า พร้อม badge/divider บอกจุดที่สลับ (เช่น `Switched: Claude CLI → Antigravity CLI · synced turns #1–#5`) และตัวบ่งชี้ว่าอีกเจ้าได้รับ sync แล้วหรือยัง (`pending sync` / `synced`)

## 5. Exit Criteria / Verification

1. คุยใน `Claude CLI` เรื่องตัวแปร/กติกาเฉพาะ 5 turns → สลับไป `Antigravity CLI` แล้วถามถึงรายละเอียดจาก Turn 1 และ Turn 4 → ตอบได้ถูกต้องครบถ้วนโดยไม่ตกหล่น
2. ทำงานต่อใน `Antigravity CLI` อีก 3 turns (แก้ไฟล์จริง) → สลับกลับมา `Claude CLI` → Claude รับรู้ไฟล์และผลเทสต์ที่ `agy` ทำไปครบโดยไม่ส่ง Turns 1–5 ซ้ำ
3. สลับเข้า `OpenCode` ใน session เดียวกัน → ทำงานต่อและสลับกลับได้ครบ loop (`Claude ↔ AGY ↔ OpenCode`)
4. ทดสอบเคสประวัติยาว (> threshold KB) → ระบบสร้างไฟล์ `.harness-web/sync/...md` อัตโนมัติ ไม่เกิด buffer truncation ใน `tmux` และยังอ้างอิงข้อมูลเก่าได้ถูกต้อง
5. Restart `apps/api` → Canonical session, `canonicalEvents`, และ `lastSyncedSeq` ของทุกเจ้ายังอยู่ครบจาก persistent store
