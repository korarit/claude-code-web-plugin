# Phase 7: UI Polish (`shadcn/ui`), Boundary Enforcement & Packaging

> **Status:** ✅ Done  
> **Parent Plan:** [roadmap.md](./roadmap.md)  
> **Depends On:** [Phase 1](./phase-01-interactive-tmux-jsonl-hooks.md) – [Phase 6](./phase-06-canonical-session-and-sync.md)  
> **Architecture Spec:** [code-structure.md](../code-structure.md)

## 1. Objective

ยกระดับคุณภาพ UI/UX, ความแข็งแรงของสถาปัตยกรรม (automated boundary checks), และความสะดวกในการติดตั้งใช้งานจริงเป็น plugin / CLI tool

## 2. Scope & Detailed Tasks

### 2.1 UI Component System (`apps/web`)
- ติดตั้งและตั้งค่า **shadcn/ui** (`components.json`, `src/lib/utils.ts` `cn()`, `src/components/ui/*`) ตาม [code-structure.md](../code-structure.md) และ [ui-concept.md](../arc/ui-concept.md) (map token เข้ากับ Light/Dark CSS variables ของระบบ)
- Refactor components ใน `features/chat` (Dialogs, Command Palette `Cmd+K` สำหรับสลับ session/model/harness/theme, Tabs, Badges)
- ปรับปรุง 2 Layout Shells (Breakpoint `1280px` ตาม [roadmap.md](./roadmap.md)):
  - `DesktopShell` (`>= 1280px`): ใช้ `Resizable` split panels สำหรับ `SessionSidebar` + `ChatPanel` + `ChangesPanel` / `TerminalPanel`
  - `CompactShell` (`< 1280px`): ใช้ `Sheet` (slide-over drawer) สำหรับ `SessionSidebar` + Bottom Bar / `Tabs` สำหรับสลับ `Chat` | `Changes` | `Agents` | `Terminal` เต็มจอ
- ตรวจ i18n completeness (ห้ามมี hardcoded UI copy ใน JSX) และปรับปรุง accessibility, keyboard shortcuts

### 2.2 Automated Boundary & Code Quality Guardrails
- เพิ่ม `eslint-plugin-boundaries` (หรือ custom dependency check script ใน Bun) บังคับกฎใน [code-structure.md](../code-structure.md):
  - `packages/core` ห้าม import external libs หรือ workspace อื่น
  - `packages/contracts` import ได้เฉพาะ `@core/*`
  - `apps/web` ห้าม import `apps/api`
  - `apps/api/src/modules/<ctx>/domain` ห้าม import infra/presentation/Elysia
  - ข้าม bounded context ห้าม deep-import `domain` หรือ `infrastructure` ของอีก context
- เพิ่ม `knip` ตรวจ unused files / exports / dependencies
- รวม script `bun run check` (`typecheck` + `lint` + `boundaries` + `test` + `build`)

### 2.3 Plugin & CLI Packaging (`plugins/web`)
- **Preflight Checks ใน `scripts/start-web.sh`:**
  - ตรวจ `bun`, `tmux`, installed harnesses (`claude`, `agy`, `opencode`), port availability, และ `apps/web/dist` (auto-build ถ้ายังไม่มีหรือ stale)
  - แสดง URL และคำสั่ง troubleshooting ชัดเจน
- **Hook Setup Helper:**
  - สคริปต์หรือคำสั่ง `--install-hooks` / `--uninstall-hooks` เพื่อติดตั้ง hook forwarder เข้า `~/.claude/settings.json` และ `~/.gemini/antigravity-cli/hooks.json` อย่างปลอดภัย (backup ก่อนแก้ + idempotent)
- **Documentation:**
  - `README.md` หลักของ repo: Quickstart, Architecture overview, Multi-harness sync guide, Subscription vs API Key safety notes, Troubleshooting

## 3. Exit Criteria / Verification

1. `bun run check` ผ่าน 100% (ไม่มี boundary violation, type error, หรือ unused code ค้าง)
2. ทดสอบ fresh install บนเครื่อง/environment ใหม่: clone → `bun install` → `bun run build` → `bun run web` หรือ `/web-start` ใช้งานได้ทันที
3. ทดสอบ `--install-hooks` และ `--uninstall-hooks` แบบ idempotent (รันซ้ำไม่พัง ไม่ทำ config เดิมหาย)
