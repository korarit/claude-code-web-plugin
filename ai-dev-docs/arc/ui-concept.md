# UI Concept — Calm Mission Control (Desktop & Mobile + i18n + Theme)

> Canonical UI/UX specification for `apps/web`  
> Enforced across all phases via [roadmap.md](../plan/roadmap.md)  
> Date (UTC): 2026-11-13

---

## 1. Visual Identity & Theme System (Light / Dark / System Default)

- **Aesthetic Direction:** *"Calm Mission Control"* — high-contrast, low-clutter developer workspace inspired by modern engineering tools (Linear / Zed / Ghostty), optimized for reading long streaming code, tool calls, and diffs.
- **Theme Modes (`"system" | "light" | "dark"`):**
  - **Default = `"system"`:** Follows OS `window.matchMedia("(prefers-color-scheme: dark)")` and updates live when the user toggles OS theme.
  - **User Override:** 3-state selector (`System` / `Light` / `Dark`) stored in `localStorage` (`hw.theme`).
  - **Zero-FOUC Boot:** Inline script in `apps/web/index.html` resolves `hw.theme` vs `prefers-color-scheme` and toggles `class="dark"` on `<html>` before React mounts.
- **Semantic Design Tokens (`apps/web/src/styles.css` with Tailwind v4):**
  - Replace hardcoded dark hex values with semantic CSS variables (`--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--border-subtle`, `--text-primary`, `--text-muted`, `--diff-add-bg`, `--diff-del-bg`).
  - **Light Palette:** Crisp warm canvas (`#fafafa` / `#ffffff`), subtle slate borders (`#e5e7eb`), high-legibility slate ink (`#111827`).
  - **Dark Palette:** Deep obsidian canvas (`#0b0d12` / `#13161e`), subtle graphite borders (`#232733`), clean neutral text (`#e5e7eb`).
- **Semantic Accents:**
  - **Harnesses:** Claude (`amber/terracotta`), Antigravity (`indigo`), OpenCode (`emerald`) — subtle pill/dot only.
  - **Session Status:**
    - `running` → Spinning loader icon (`animate-spin`) + subtle active indicator
    - `waiting_permission` → Amber alert ring + `"Action Required"` badge
    - `idle` → Muted neutral/green indicator
    - `error` / `stopped` → Rose / Muted gray

---

## 2. English-Only Copy & Type-Safe i18n Foundation

- **Strict UI Language Rule:** All visible UI labels, buttons, empty states, status badges, filter chips (`"All Sources"`, `"Web"`, `"CLI"`, `"tmux"`, `"IDE"`, `"Continue in Web"`), tooltips, confirmation modals, and client-side messages MUST be in **English** (`"New Session"`, `"Waiting for approval"`, `"Session Changes"`, `"Back to Main"`, `"Archive"`, `"Delete permanently"`).
- **Type-Safe i18n Architecture (`apps/web/src/lib/i18n/`):**
  - `locales/en.ts`: Canonical typed dictionary (`export type TranslationMessages = typeof en`)
  - `I18nProvider.tsx` + `useTranslation()`: Exposes `t(key, params?)` with compile-time key safety, placeholder interpolation (`{{count}}`, `{{name}}`), and `Intl.RelativeTimeFormat` / `Intl.NumberFormat`
  - **Rule:** Never hardcode visible UI strings inside JSX components; all UI copy goes through `t(...)` so adding future locales only requires implementing `TranslationMessages`.

---

## 3. Desktop UI (`width >= 1280px` — `DesktopShell`)

3-Column Workspace (`100dvh`, independent pane scrolling, zero outer page scroll):

```text
+---------------------------------------------------------------------------------------------------+
| Top Bar (44px): [Workspace Title]  [Session Name (rename)] [Harness·Model] | [Context Bar 71%]    |
|                 [Changes (4)] [Terminal] [Agents]  |  [Sound] [Theme: System/Light/Dark]          |
+-------------------+-----------------------------------------------+-------------------------------+
| Left Rail (260px) | Center Stage (flex-1, min-w-0)                | Right Inspector (380-520px)   |
|                   |                                               | (Toggleable / Resizable)      |
| [+ New Session]   | [Subagent Banner: <- Back to Main | Child]    | [Changes (4)] | [Terminal]    |
| [Search...]       | [Mirror Banner: CLI/IDE · Auto-saved          |-------------------------------|
| [Src v][Har][Proj]|  [Continue in Web]] (when external mirror)    | Mode: [Session] [All Git]     |
|                   |                                               | Filter: [All Harnesses v]     |
| Active Sessions   |  User: Fix auth timeout bug...                |                               |
|  * Fix Auth   [⟳] |  Assistant (Markdown + Copy Code):            | M src/auth.ts +14 -3 [claude] |
|    web·claude·repo|    > Edited src/auth.ts (+14 -3) [pill]       | A auth.test.ts +32   [agy]    |
|    └ Research [⟳] |    > Collapsible Bash: bun test (passed)      |-------------------------------|
|  o IDE Session    |                                               | [Unified | Side-by-Side | Raw]|
|    ide·agy·repo   |  [PendingInteraction Card (if waiting)]       |  12 - const x = 1;            |
| > Archived (3)    |  Allow `bun test`? [Allow Once] [Always] [No] |  12 + const x = 2;            |
|                   |-----------------------------------------------+                               |
|                   | Composer: [@file] [/cmd] [Image] | [Model v]  |                               |
|                   | [Type a prompt... (Enter to send)]            |                               |
|                   | [Harness v]                   [Stop / Send]   |                               |
+-------------------+-----------------------------------------------+-------------------------------+
```

- **Key Desktop Behaviors:**
  - Clicking an inline file pill (`Edited src/auth.ts +14 -3`) opens the Right Inspector directly to that file's diff side-by-side with the chat.
  - `ChangesPanel` supports **Side-by-Side** and **Unified** diff toggles plus per-revision (`harnessId · model`) inspection.
  - Left Rail displays active sessions (with `origin` badge: `web` / `cli` / `tmux` / `ide`, `harness · model`, and project folder), **multi-axis filters** (`Source/Origin`, `Harness`, `Project cwd`, `Search`), nested subagent trees with individual loading spinners, inline Rename, Archive drawer, and Permanent Delete.
  - When viewing an auto-discovered external `mirror` session (`cli` outside `tmux` or `ide`), the Center Stage streams updates live and shows `[Continue in Web]` to adopt/resume it into an interactive runner (or switch harness).

---

## 4. Mobile / Compact UI (`width < 1280px` — `CompactShell`)

Single-Focus Thumb-Friendly Workspace (`100dvh`, `env(safe-area-inset-bottom)`, zero horizontal page overflow):

```text
+------------------------------------------+
| Compact Header (48px):                   |
| [☰ (•)]  [Session Title v]               |
|                  [Sound] [Theme] [More]  |
+------------------------------------------+
| Thin 3px Context Progress Strip          |
| [<- Back to Main] (if inside subagent)   |
+------------------------------------------+
|                                          |
|  Active Full-Screen View                 |
|  1) Chat:                                |
|     - Full-width Markdown & tool blocks  |
|     - Sticky PendingInteraction card     |
|       above composer                     |
|     - Tap file pill -> jumps to Changes  |
|                                          |
|  2) Changes (N):                         |
|     - Compact file selector bar at top   |
|     - Unified Diff (mobile-first!)       |
|       + [View Full File] button          |
|                                          |
|  3) Agents:                              |
|     - Single-column cards (tap to drill) |
|                                          |
|  4) Terminal:                            |
|     - xterm + accessory key row          |
|       ([Tab] [Esc] [Ctrl+C] [↑] [↓] [↵]) |
+------------------------------------------+
| Composer (when on Chat tab):             |
| [+ /cmd/@file] [Prompt input...] [Send]  |
+------------------------------------------+
| Bottom View Bar (48px):                  |
| [Chat]   [Changes (4)]   [Agents]  [Term]|
+------------------------------------------+
```

- **Key Compact / Mobile Behaviors:**
  - **Slide-over Session Drawer (`☰`):** Opens `SessionSidebar` (including `Source/Origin`, `Harness`, `Project cwd`, and `Search` filters) in an `85vw` (`max-w-[320px]`) slide-over sheet. When closed, the `☰` button shows a pulsing badge if any background session is `running` or `waiting_permission`.
  - **Unified Diff Default:** `ChangesPanel` defaults to **Unified Diff** with horizontal scroll scoped inside the code card only (never widening the viewport).
  - **Sticky Interaction Banner:** `PendingInteraction` (`Allow Once` / `Deny` / choice cards) pins directly above the composer so approvals never get buried in scroll.
  - **External Mirror Banner:** When inspecting an external `cli` / `ide` `mirror` session on mobile, pins `[Continue in Web]` cleanly above the bottom bar.
  - **Terminal Accessory Toolbar:** Provides `[Tab]`, `[Esc]`, `[Ctrl+C]`, `[↑]`, `[↓]`, `[Enter]` above the virtual keyboard on the `Terminal` tab.

---

## 5. Responsive State Preservation Rule (Option 3)

- **Single Resource Route:** `/` | `/sessions/:sessionId` | `/sessions/:sessionId/agents/:agentId` (never separate `/mobile` vs `/desktop` routes).
- **Shared Root State:** `WorkspacePage` holds `useSessions()`, `useChat()`, `useChanges()`, `ThemeProvider`, and `I18nProvider` above `DesktopShell` / `CompactShell`, ensuring viewport resizes across `1280px` preserve live SSE streams, loading indicators, and unsent prompt drafts.
