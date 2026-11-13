# Project Roadmap — Multi-Phase Implementation Plan

> เป้าหมายระยะยาว: สร้าง Web UI + Plugin สำหรับควบคุม เฝ้าดูไฟล์เปลี่ยน/โค้ด และสลับใช้งาน AI coding harnesses (**Claude CLI**, **Antigravity CLI**, **OpenCode**) ภายใน session เดียวกันแบบไร้รอยต่อ บน architecture แบบ DDD Modular Monolith
>
> อ้างอิงโครงสร้างโค้ด: [code-structure.md](../code-structure.md)  
> Last Updated (UTC): 2026-11-13

---

## Phases Index (1 File per Phase)

| Phase | รายละเอียด | สถานะ | Feature / Spec Docs |
| :---: | :--- | :---: | :--- |
| **Phase 0** | [Monorepo Foundation & V1 Spike (`claude -p`)](./phase-00-monorepo-and-v1-spike.md) | ✅ Done | [20261103-claude-web-ui.md](../feature/20261103-claude-web-ui.md) |
| **Phase 1** | [Interactive `tmux` Runner + `.jsonl` Watcher + Hooks](./phase-01-interactive-tmux-jsonl-hooks.md) | ✅ Done | [20261113-interactive-tmux-jsonl-runner.md](../feature/20261113-interactive-tmux-jsonl-runner.md) |
| **Phase 2** | [Interactive Controls, Session Discovery & Auth Modes](./phase-02-interactive-controls-and-discovery.md) | ✅ Done | [20261113-interactive-controls-and-discovery.md](../feature/20261113-interactive-controls-and-discovery.md) |
| **Phase 3** | [Session Code Preview, File Changes & Diff Viewer](./phase-03-code-preview-and-file-changes.md) | ✅ Done | [20261113-code-preview-and-file-changes.md](../feature/20261113-code-preview-and-file-changes.md) |
| **Phase 4** | [Multi-Agent Visibility & Worktree Dashboard](./phase-04-multi-agent-and-worktree-dashboard.md) | ✅ Done | [20261113-multi-agent-and-worktree-dashboard.md](../feature/20261113-multi-agent-and-worktree-dashboard.md) |
| **Phase 5** | [Multi-Harness Adapters (`Claude CLI`, `Antigravity CLI`, `OpenCode`)](./phase-05-multi-harness-adapters.md) | ✅ Done | [20261113-multi-harness-adapters.md](../feature/20261113-multi-harness-adapters.md) |
| **Phase 6** | [Canonical Session Store & Full-Verbatim Cross-Harness Sync](./phase-06-canonical-session-and-sync.md) | ✅ Done | [20261113-canonical-session-and-sync.md](../feature/20261113-canonical-session-and-sync.md) |
| **Phase 7** | [UI Polish (`shadcn/ui`), Boundary Enforcement & Packaging](./phase-07-ui-polish-boundaries-packaging.md) | ✅ Done | [code-structure.md](../code-structure.md) |

---

## Dependency Order

```text
Phase 0 (Done: Monorepo + DDD + V1 Spike)
   │
   ▼
Phase 1 (Next: tmux Interactive + .jsonl Watcher + Hooks)
   │
   ▼
Phase 2 (Interactive Input/Permission + Session Discovery + Auth Modes)
   │
   ▼
Phase 3 (Session Code Preview + File Changes + Diff Viewer)
   │
   ├──────────────────────────────────────────┐
   ▼                                          ▼
Phase 4 (Multi-Agent + Git Worktree)     Phase 5 (3 Harness Adapters: claude / agy / opencode)
   │                                          │
   │                                          ▼
   │                                     Phase 6 (Canonical Session + Full-Verbatim Delta Sync)
   │                                          │
   └──────────────────┬───────────────────────┘
                      ▼
                Phase 7 (shadcn/ui + Boundary Lint + Packaging)
```

---

## Frontend Architecture Rule (บังคับใช้ทุก Phase — Option 3 + UI Concept)

> สเปคหน้าตา, โทนสี, i18n และ layout เต็มดูที่ [ui-concept.md](../arc/ui-concept.md)

เพื่อรองรับทั้ง **Mobile / Compact (`width < 1280px`)** และ **Desktop (`width >= 1280px`)** โดยไม่ให้ SSE stream หรือ state หลุดเมื่อปรับขนาดหน้าจอ:

1. **Single Resource Route (ห้ามแยก Route ตามขนาดจอ):**
   - ใช้ URL ตาม Resource เดียวกันทุกอุปกรณ์ (เช่น `/`, `/sessions/:sessionId`, `/sessions/:sessionId/agents/:agentId`) ห้ามสร้าง `/mobile/...` vs `/desktop/...`
2. **Shared State & Hooks ที่ Root (`WorkspacePage`):**
   - State ของ `useSessions()`, `useChat()`, `useChanges()` อยู่ที่ `WorkspacePage` ชั้นบนสุดที่เดียว เพื่อให้การ resize ข้ามจุดตัด `1280px` **ไม่ unmount hooks และไม่ตัด SSE connection**
3. **Reusable Feature Panels + 2 Responsive Layout Shells (`1280px` = Tailwind `xl`):**
   - ไส้ใน (`SessionSidebar`, `ChatPanel`, `ChangesPanel`, `TerminalPanel`, `AgentBoard`) เขียนชุดเดียวรับ props จาก state กลาง
   - **`DesktopShell` (`>= 1280px`):** Multi-pane Split View (`[SessionSidebar 260px] | [Chat / Subagent flex-1] | [ChangesDiff / Terminal resizable]`)
   - **`CompactShell` (`< 1280px`):** Single-Focus View + Header เปิด **`SessionSidebar` แบบ Slide-over Drawer** + Bottom Bar / Tab Switcher สลับเต็มจอทีละ view (`Chat` | `Changes` | `Agents` | `Terminal`)
4. **English-Only UI + Type-Safe i18n:**
   - ข้อความบน UI เป็น **ภาษาอังกฤษล้วน** และห้าม hardcode string ใน component — เรียกผ่าน `useTranslation()` (`locales/en.ts`) เสมอเพื่อรองรับการเพิ่มภาษาในอนาคตแบบ type-safe
5. **Dark / Light Theme (Default = System):**
   - รองรับ 3 โหมด (`system` default | `light` | `dark`) ใช้ semantic CSS variables + zero-FOUC inline script ใน `index.html` ตาม theme เครื่องอัตโนมัติ
