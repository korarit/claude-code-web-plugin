#!/usr/bin/env bash
# Forward Claude Code Hook JSON from stdin to local harness-web API.
# Must ALWAYS exit 0 quickly (<200ms) when the web server is stopped,
# except PermissionRequest which long-polls for a Web UI decision with timeout fallback.
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

EVENT_NAME=""
if command -v jq >/dev/null 2>&1; then
  EVENT_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null || true)"
else
  EVENT_NAME="$(printf '%s' "$PAYLOAD" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | head -n1 || true)"
fi

HEADERS=(-H "Content-Type: application/json")
if [[ -n "$TOKEN" ]]; then
  HEADERS+=(-H "X-Harness-Token: ${TOKEN}")
fi
if [[ -n "${CLAUDE_WEB_SESSION_ID:-}" ]]; then
  HEADERS+=(-H "X-Claude-Web-Session-Id: ${CLAUDE_WEB_SESSION_ID}")
fi
if [[ -n "${AGY_WEB_SESSION_ID:-}" ]]; then
  HEADERS+=(-H "X-Agy-Web-Session-Id: ${AGY_WEB_SESSION_ID}" -H "X-Harness-Id: agy")
fi
if [[ -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then
  TMUX_NAME="$(tmux display-message -p -t "${TMUX_PANE}" '#{session_name}' 2>/dev/null || true)"
  if [[ -n "$TMUX_NAME" ]]; then
    HEADERS+=(-H "X-Tmux-Session: ${TMUX_NAME}")
  fi
fi

if [[ "$EVENT_NAME" == "PermissionRequest" ]] || [[ "$EVENT_NAME" == "PreToolUse" && "${HARNESS_WAIT_PRETOOLUSE:-0}" == "1" ]]; then
  HEADERS+=(-H "X-Harness-Wait-Decision: 1")
  RESPONSE="$(curl -sS --connect-timeout 0.15 -m 60 -X POST \
    "http://127.0.0.1:${PORT}/api/chat/hooks" \
    "${HEADERS[@]}" \
    -d "$PAYLOAD" 2>/dev/null || true)"

  if [[ -n "$RESPONSE" ]] && command -v jq >/dev/null 2>&1; then
    HOOK_JSON="$(printf '%s' "$RESPONSE" | jq -c '.data.hookOutput // empty' 2>/dev/null || true)"
    if [[ -n "$HOOK_JSON" && "$HOOK_JSON" != "null" ]]; then
      printf '%s\n' "$HOOK_JSON"
    fi
  fi
  exit 0
fi

curl -sS --connect-timeout 0.1 -m 0.15 -X POST \
  "http://127.0.0.1:${PORT}/api/chat/hooks" \
  "${HEADERS[@]}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

exit 0
