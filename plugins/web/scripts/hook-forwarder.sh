#!/usr/bin/env bash
# Forward Claude Code Hook JSON from stdin to local harness-web API.
# Must ALWAYS exit 0 quickly (<200ms) even when the web server is stopped.
set -u

HARNESS_HOME="${HARNESS_WEB_HOME:-$HOME/.harness-web}"
RUNTIME_FILE="${HARNESS_HOME}/runtime.json"

PORT="${CLAUDE_WEB_PORT:-}"
TOKEN="${CLAUDE_WEB_TOKEN:-}"
PID=""

if [[ -z "$PORT" || -z "$TOKEN" ]]; then
  if [[ ! -f "$RUNTIME_FILE" ]]; then
    exit 0
  fi
  if command -v jq >/dev/null 2>&1; then
    PORT="${PORT:-$(jq -r '.port // empty' "$RUNTIME_FILE" 2>/dev/null || true)}"
    TOKEN="${TOKEN:-$(jq -r '.token // empty' "$RUNTIME_FILE" 2>/dev/null || true)}"
    PID="$(jq -r '.pid // empty' "$RUNTIME_FILE" 2>/dev/null || true)"
  else
    PORT="${PORT:-$(grep -oE '"port":[[:space:]]*[0-9]+' "$RUNTIME_FILE" 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)}"
    TOKEN="${TOKEN:-$(grep -oE '"token":[[:space:]]*"[^"]+"' "$RUNTIME_FILE" 2>/dev/null | sed -E 's/.*"([^"]+)"$/\1/' | head -n1 || true)}"
  fi
fi

if [[ -z "$PORT" ]]; then
  exit 0
fi

# Fast-skip stale runtime.json if PID is known dead.
if [[ -n "$PID" ]] && ! kill -0 "$PID" 2>/dev/null; then
  exit 0
fi

PAYLOAD="$(cat || true)"
if [[ -z "$PAYLOAD" ]]; then
  PAYLOAD="{}"
fi

HEADERS=(-H "Content-Type: application/json")
if [[ -n "$TOKEN" ]]; then
  HEADERS+=(-H "X-Harness-Token: ${TOKEN}")
fi
if [[ -n "${CLAUDE_WEB_SESSION_ID:-}" ]]; then
  HEADERS+=(-H "X-Claude-Web-Session-Id: ${CLAUDE_WEB_SESSION_ID}")
fi

curl -sS --connect-timeout 0.1 -m 0.15 -X POST \
  "http://127.0.0.1:${PORT}/api/chat/hooks" \
  "${HEADERS[@]}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0
