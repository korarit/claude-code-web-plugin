# Project Roadmap — Multi-Phase Implementation Plan

> เป้าหมายระยะยาว: สร้าง Web UI + Plugin สำหรับควบคุม เฝ้าดู และสลับใช้งาน AI coding harnesses (**Claude CLI**, **Antigravity CLI**, **OpenCode**) ภายใน session เดียวกันแบบไร้รอยต่อ บน architecture แบบ DDD Modular Monolith
>
> อ้างอิงโครงสร้างโค้ด: [code-structure.md](../code-structure.md)  
> Last Updated (UTC): 2026-11-13

---

## Phases Index (1 File per Phase)

| Phase | รายละเอียด | สถานะ | Feature / Spec Docs |
| :---: | :--- | :---: | :--- |
| **Phase 0** | [Monorepo Foundation & V1 Spike (`claude -p`)](./phase-00-monorepo-and-v1-spike.md) | ✅ Done | [20261103-claude-web-ui.md](../feature/20261103-claude-web-ui.md) |
| **Phase 1** | [Interactive `tmux` Runner + `.jsonl` Watcher + Hooks](./phase-01-interactive-tmux-jsonl-hooks.md) | 🚧 Next | [20261113-interactive-tmux-jsonl-runner.md](../feature/20261113-interactive-tmux-jsonl-runner.md) |
| **Phase 2** | [Interactive Controls, Session Discovery & Auth Modes](./phase-02-interactive-controls-and-discovery.md) | 📋 Planned | — |
| **Phase 3** | [Multi-Agent Visibility & Worktree Dashboard](./phase-03-multi-agent-and-worktree-dashboard.md) | 📋 Planned | — |
| **Phase 4** | [Multi-Harness Adapters (`Claude CLI`, `Antigravity CLI`, `OpenCode`)](./phase-04-multi-harness-adapters.md) | 📋 Planned | — |
| **Phase 5** | [Canonical Session Store & Full-Verbatim Cross-Harness Sync](./phase-05-canonical-session-and-sync.md) | 📋 Planned | — |
| **Phase 6** | [UI Polish (`shadcn/ui`), Boundary Enforcement & Packaging](./phase-06-ui-polish-boundaries-packaging.md) | 📋 Planned | [code-structure.md](../code-structure.md) |

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
   ├──────────────────────────────────────────┐
   ▼                                          ▼
Phase 3 (Multi-Agent + Worktree)         Phase 4 (3 Harness Adapters: claude / agy / opencode)
   │                                          │
   │                                          ▼
   │                                     Phase 5 (Canonical Session + Full-Verbatim Delta Sync)
   │                                          │
   └──────────────────┬───────────────────────┘
                      ▼
                Phase 6 (shadcn/ui + Boundary Lint + Packaging)
```
