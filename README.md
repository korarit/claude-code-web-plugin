# Harness Web Plugin

A local-first Web UI, REST/SSE/WebSocket server, and CLI plugin for running, inspecting, and seamlessly switching between **Claude Code (`claude`)**, **Antigravity CLI/IDE (`agy`)**, and **OpenCode (`opencode`)** within a single conversation thread.

Built as a **DDD Modular Monolith** with Bun, Elysia, React 18, Tailwind CSS v4, and `shadcn/ui`.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh/) `>= 1.3`
- `tmux` (required for interactive `claude` and `agy` sessions)
- One or more supported harnesses on `PATH`: `claude`, `agy`, `opencode`
- `curl` (and optionally `jq`) for `hook-forwarder.sh`

### Fresh Install & Run

```bash
git clone <repo-url>
cd harness-swicth-web-plugin

bun install
bun run build
bun run web
```

Or launch with the plugin script (performs preflight checks, auto-builds `apps/web/dist` if missing/stale, checks port availability):

```bash
bash plugins/web/scripts/start-web.sh --port 3000
```

Then open **http://127.0.0.1:3000** (or trigger `/web-start` inside Claude Code when loaded as a plugin).

### Install Lifecycle Hooks (Recommended)

Install the non-blocking/permission hook forwarder into `~/.claude/settings.json` and `~/.gemini/antigravity-cli/hooks.json` (creates timestamped `.bak` backups and is idempotent):

```bash
bash plugins/web/scripts/start-web.sh --install-hooks
# or via npm script:
bun run hooks:install
```

To remove only the managed hook forwarder entries later:

```bash
bash plugins/web/scripts/start-web.sh --uninstall-hooks
# or:
bun run hooks:uninstall
```

---

## Architecture Overview

```text
├── packages/
│   ├── core/          # Pure zero-dependency Shared Kernel (Result, AppError, Clock, IDs, utils)
│   └── contracts/     # FE <-> BE shared DTOs & types (@contracts/*)
├── apps/
│   ├── api/           # Elysia backend (DDD bounded contexts wired at apps/api/src/index.ts)
│   │   └── src/modules/
│   │       ├── chat/      # Sessions, tmux runner, hooks, SSE stream, terminal WebSocket
│   │       ├── changes/   # Per-session & git diffs, snapshots, revert, file attribution
│   │       ├── agents/    # Subagent trees, telemetry, shared task board
│   │       ├── workspace/ # Git worktree creation, diff review, merge & cleanup
│   │       ├── harness/   # Claude, Antigravity (agy), and OpenCode adapters
│   │       └── sync/      # SQLite Canonical Session Store & Full-Verbatim Delta Sync
│   └── web/           # React + Vite + Tailwind v4 + shadcn/ui + Cmd+K Command Palette
│       └── src/
│           ├── components/ui/     # shadcn/ui primitives (Dialog, Sheet, Tabs, Resizable, Command)
│           └── features/chat/     # DesktopShell (>=1280px), CompactShell (<1280px), panels, hooks
└── plugins/web/       # Claude Code plugin manifest, /web-start command, start-web.sh, hook-forwarder.sh
```

### Enforced Dependency Boundaries

- `packages/core` imports nothing external and no other workspace.
- `packages/contracts` imports only `@core/*`.
- `apps/web` imports only `@core/*` and `@contracts/*` (never `apps/api`).
- `apps/api/src/modules/<ctx>/domain` never imports `application`, `infrastructure`, `presentation`, or `elysia`.
- Bounded contexts never deep-import across modules; all cross-context wiring happens via ports in `apps/api/src/index.ts`.

---

## Multi-Harness Canonical Sync Guide

Harness Web maintains a local SQLite **Canonical Session Store** (`~/.harness-web/canonical-sessions.db`) with per-harness cursors (`lastSyncedSeq`):

1. **Zero-Loss Verbatim History:** Every turn across `claude`, `agy`, and `opencode` is normalized and stored verbatim with monotonically increasing `seq`.
2. **Lazy Delta Sync on Next Prompt:** Switching harnesses in the UI updates `activeHarness` immediately without wasting tokens. On your next prompt, only unsynced turns (`seq > target.lastSyncedSeq`) are injected once into the target harness.
3. **Large-History File Sync Fallback:** If a delta exceeds the byte/turn threshold or approaches the target model's context limit, the full transcript is written to `.harness-web/sync/<sessionId>-<fromSeq>-<toSeq>.md` and referenced automatically.
4. **External Auto-Ingest & Adopt:** Existing CLI, tmux, IDE mirror, and OpenCode sessions discovered on your machine are automatically ingested into the Canonical Store so **Continue in Web** or switching harnesses works from turn 1.

---

## Subscription vs API Key Safety Notes

- **Local CLI OAuth (`machine_default`, default):** Reuses the machine's local CLI login (Claude Pro/Max, Antigravity, OpenCode). Intended strictly for personal local use — do not expose the server publicly (`HOST` defaults to `127.0.0.1`). A concurrency soft warning triggers when multiple OAuth sessions run simultaneously.
- **API Key (`api_key`):** Optional pay-as-you-go isolation mode for Claude sessions when `ANTHROPIC_API_KEY` is configured on the API server environment.

---

## Verification & Quality Checks

Run the full verification suite (typecheck, ESLint + `eslint-plugin-boundaries`, AST boundary check, `knip` unused-code check, Bun tests, and production builds):

```bash
bun run check
```

Individual checks:

```bash
bun run typecheck
bun run lint
bun run boundaries
bun run unused
bun test
bun run build
```

---

## Troubleshooting

- **`bun: command not found`**: Ensure `~/.bun/bin` is on your `PATH`, or run via `bash plugins/web/scripts/start-web.sh` (which auto-detects `~/.bun/bin/bun`).
- **`tmux` missing**: Install `tmux` (`sudo apt install tmux` or `brew install tmux`). Without `tmux`, OpenCode and external mirror inspection still work, while interactive `claude`/`agy` sessions cannot spawn.
- **Port already in use**: Check active listeners with `lsof -i :3000` or pass `--port 4000`.
- **Hooks not firing**: Verify `~/.claude/settings.json` and `~/.gemini/antigravity-cli/hooks.json` with `bun run hooks:install`, and confirm `~/.harness-web/runtime.json` points to the running server PID/port.
- **UI returns `web dist not found`**: Run `bun run build` or start via `bash plugins/web/scripts/start-web.sh` (auto-rebuilds stale/missing `apps/web/dist`).
