# Issue: Terminal WebSocket `terminalAttachments` WeakMap keys on ephemeral Elysia WS wrappers, dropping all terminal input and leaking polling attachments

## 1. Problem Statement / Reproduction
- **Group**: Group 7 (Inspector Panels — Changes & Diff Viewer, Multi-Agent Board & Terminal Attach)
- **Harness**: All harnesses supporting interactive tmux attachment (`agy`, `claude`)
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Start an active interactive session with tmux enabled (e.g. Antigravity session).
  2. Open the `Terminal` inspector panel. The WebSocket connects (`open` callback fires) and displays the live tmux screen.
  3. Click any accessory key button (`Tab`, `Esc`, `Ctrl+C`, `↑`, `↓`, `↵`) or type text into the terminal input box and click "Send".
- **Actual Result**:
  - The message is sent over the WebSocket (`{"type":"key","key":"Tab"}` or `{"type":"text","text":"..."}`).
  - The server's `message(ws, raw)` handler executes, but `terminalAttachments.get(ws)` returns `undefined`.
  - The key/text is silently dropped; nothing is ever forwarded to `attachment.sendKey()` or `attachment.sendText()` and tmux never receives any keys or input.
  - Furthermore, when the client closes the terminal tab or disconnects, `close(ws)` executes and `terminalAttachments.get(ws)` also returns `undefined`, so `attachment.close()` is never called, leaving the 250ms `setInterval` polling loop leaking in memory indefinitely.
  - Screenshots / Logs: `/tmp/e2e-harness-full/artifacts/group7-inspector-panels/07-terminal-panel.png`.
- **Expected Result**:
  - Accessory keys and typed text sent from the Terminal panel must be delivered to tmux.
  - When the client disconnects, `attachment.close()` must be called to terminate the polling timer.

## 2. Root Cause Hypothesis
- In [apps/api/src/modules/chat/presentation/chat.routes.ts](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/api/src/modules/chat/presentation/chat.routes.ts#L231), `terminalAttachments` is defined as:
  ```ts
  const terminalAttachments = new WeakMap<object, TerminalAttachment>();
  ```
- In lines 474–490, `open(ws)` associates the attachment with the `ws` argument:
  ```ts
  terminalAttachments.set(ws, attachment);
  ```
- In lines 492–495:
  ```ts
  async message(ws, raw) {
    const attachment = terminalAttachments.get(ws);
    if (!attachment) return;
  ```
- And lines 511–515:
  ```ts
  close(ws) {
    const attachment = terminalAttachments.get(ws);
    if (attachment) {
      attachment.close();
      terminalAttachments.delete(ws);
    }
  }
  ```
- In Elysia / Bun WebSocket routing, the `ws` object provided to each event handler callback (`open`, `message`, `close`) is a transient wrapper created per event, not a persistent object reference across events.
- Because `ws` in `message` and `close` is not referentially identical to `ws` in `open`, `terminalAttachments.get(ws)` returns `undefined` 100% of the time, silently dropping all user input and leaking the attachment timer.

## 3. Proposed Fix(es)
### Option 1: Key by `ws.id` using `Map<string, TerminalAttachment>`
- In Elysia WebSocket connections, `ws.id` is a stable string identifier assigned to the socket connection across `open`, `message`, and `close`.
- Use `const terminalAttachments = new Map<string, TerminalAttachment>();` and index by `ws.id`.
- Pros: Simple, idiomatic for Elysia WS connection state management, eliminates object identity issues.
- Cons: Must ensure cleanup in `close(ws)` using `terminalAttachments.delete(ws.id)` (which is already implemented).

### Option 2: Key `WeakMap` on `ws.raw`
- `ws.raw` is the underlying Bun native WebSocket object, which remains stable across calls.
- Pros: Retains `WeakMap` GC semantics.
- Cons: `ws.raw` is an internal Bun implementation detail that could change across framework versions.

### Recommended: Option 1
- Key by `ws.id` with `Map<string, TerminalAttachment>`. It is standard across Elysia websocket implementations and explicitly cleans up on `close`.

## 4. File-Level Change Plan
- [chat.routes.ts](file:///home/korarit/Desktop/harness-swicth-web-plugin/apps/api/src/modules/chat/presentation/chat.routes.ts):
  - Change line 231 from `const terminalAttachments = new WeakMap<object, TerminalAttachment>();` to `const terminalAttachments = new Map<string, TerminalAttachment>();`.
  - In `open(ws)` (line 490): change `terminalAttachments.set(ws, attachment)` to `terminalAttachments.set(ws.id, attachment)`.
  - In `message(ws, raw)` (line 493): change `terminalAttachments.get(ws)` to `terminalAttachments.get(ws.id)`.
  - In `close(ws)` (lines 511–514): change `terminalAttachments.get(ws)` to `terminalAttachments.get(ws.id)` and `terminalAttachments.delete(ws.id)`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 7 (`group7-inspector-panels.ts`):
  - Click `Tab` button -> verify `[KEY:Tab]` appears in captured terminal screen.
  - Send text `echo test-terminal` -> verify text appears in captured terminal screen.
  - Close terminal panel or navigate away -> verify `attachment.close()` terminates the timer.
