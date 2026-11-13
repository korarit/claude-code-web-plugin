#!/usr/bin/env bash
# Start harness-web: Elysia API + static web UI on a single port, with preflight checks
# and hook management helpers (--install-hooks / --uninstall-hooks).
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
DRY_RUN=0
NO_BUILD=0
HOOK_ACTION=""
EXTRA_HOOK_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)
      PORT="${2:?missing value for $1}"; shift 2;;
    --port=*)
      PORT="${1#--port=}"; shift;;
    --host)
      HOST="${2:?missing value for $1}"; shift 2;;
    --host=*)
      HOST="${1#--host=}"; shift;;
    --install-hooks)
      HOOK_ACTION="install"; shift;;
    --uninstall-hooks)
      HOOK_ACTION="uninstall"; shift;;
    --claude-settings|--agy-hooks)
      EXTRA_HOOK_ARGS+=("$1" "${2:?missing value for $1}"); shift 2;;
    --no-build)
      NO_BUILD=1; shift;;
    --dry-run)
      DRY_RUN=1; shift;;
    --help|-h)
      cat <<'EOF'
Usage: start-web.sh [options]

Options:
  --port, -p <n>       HTTP port to listen on (default: 3000)
  --host <addr>        Bind hostname (default: 127.0.0.1)
  --install-hooks      Install hook forwarder into Claude & Antigravity configs (with backup)
  --uninstall-hooks    Remove hook forwarder from Claude & Antigravity configs (with backup)
  --no-build           Skip automatic build when apps/web/dist is missing or stale
  --dry-run            Run preflight checks and print planned command without executing
  --help, -h           Show this help message
EOF
      exit 0;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        PORT="$1"
        shift
      else
        echo "[error] Unknown option: $1 (run with --help for usage)" >&2
        exit 2
      fi
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [[ -x "${HOME}/.bun/bin/bun" ]]; then
    printf '%s\n' "${HOME}/.bun/bin/bun"
    return 0
  fi
  return 1
}

BUN_BIN="$(resolve_bun || true)"
if [[ -z "$BUN_BIN" ]]; then
  echo "[error] 'bun' is not installed or not found on PATH." >&2
  echo "        Install Bun: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if [[ -n "$HOOK_ACTION" ]]; then
  HOOK_ARGS=("--${HOOK_ACTION}")
  if [[ ${#EXTRA_HOOK_ARGS[@]} -gt 0 ]]; then
    HOOK_ARGS+=("${EXTRA_HOOK_ARGS[@]}")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    HOOK_ARGS+=("--dry-run")
  fi
  exec "$BUN_BIN" "$ROOT/plugins/web/scripts/install-hooks.ts" "${HOOK_ARGS[@]}"
fi

echo "==> Harness Web Preflight Checks"
echo "    bun:      $("$BUN_BIN" --version) ($BUN_BIN)"

if command -v tmux >/dev/null 2>&1; then
  echo "    tmux:     ok ($(tmux -V))"
else
  echo "    tmux:     [warn] not found on PATH (required for interactive Claude/AGY tmux sessions)"
fi

for bin in claude agy opencode; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "    $bin: ok ($(command -v "$bin"))"
  else
    echo "    $bin: not found on PATH"
  fi
done

WEB_DIST_INDEX="$ROOT/apps/web/dist/index.html"
NEEDS_BUILD=0
if [[ ! -f "$WEB_DIST_INDEX" ]]; then
  NEEDS_BUILD=1
  DIST_REASON="missing apps/web/dist/index.html"
else
  STALE_SRC="$(find \
    "$ROOT/apps/web/src" \
    "$ROOT/apps/web/index.html" \
    "$ROOT/packages/contracts/src" \
    "$ROOT/packages/core/src" \
    -type f -newer "$WEB_DIST_INDEX" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$STALE_SRC" ]]; then
    NEEDS_BUILD=1
    DIST_REASON="stale relative to ${STALE_SRC#"$ROOT/"}"
  fi
fi

if [[ "$NEEDS_BUILD" -eq 1 ]]; then
  if [[ "$DRY_RUN" -eq 1 || "$NO_BUILD" -eq 1 ]]; then
    echo "    web dist: [warn] $DIST_REASON (build skipped)"
  else
    echo "    web dist: building ($DIST_REASON)..."
    (cd "$ROOT/apps/web" && "$BUN_BIN" run build)
  fi
else
  echo "    web dist: up to date"
fi

if ! "$BUN_BIN" -e '
const host = process.argv[1];
const port = Number(process.argv[2]);
try {
  const srv = Bun.listen({
    hostname: host,
    port,
    socket: { data() {} },
  });
  srv.stop(true);
} catch {
  process.exit(1);
}
' "$HOST" "$PORT" >/dev/null 2>&1; then
  echo "[error] Port ${HOST}:${PORT} is already in use or cannot be bound." >&2
  echo "        Check with: lsof -i :${PORT}   or start on another port: $0 --port 4000" >&2
  exit 1
fi

CMD=("$BUN_BIN" "$ROOT/apps/api/src/index.ts" "--host" "$HOST" "--port" "$PORT")

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "${CMD[@]}"
  exit 0
fi

echo "==> Starting Harness Web at http://${HOST}:${PORT}"
echo "    Hooks helper: bash $ROOT/plugins/web/scripts/start-web.sh --install-hooks"
echo "    Tmux sessions: tmux ls"

exec "${CMD[@]}"
