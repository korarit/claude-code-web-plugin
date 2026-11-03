#!/usr/bin/env bash
# Start claude-web: Elysia API + static web UI on a single port.
# Usage: start-web.sh [--port <n> | --port=<n> | -p <n> | <n>] [--dry-run]
set -euo pipefail

PORT="3000"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)
      PORT="${2:?missing value for $1}"; shift 2;;
    --port=*)
      PORT="${1#--port=}"; shift;;
    --dry-run)
      DRY_RUN=1; shift;;
    --help|-h)
      echo "Usage: start-web.sh [--port <n>] [--dry-run]"; exit 0;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then PORT="$1"; fi
      shift;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CMD=(bun "$ROOT/apps/api/src/index.ts" --port "$PORT")

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "${CMD[@]}"
  exit 0
fi

exec "${CMD[@]}"
