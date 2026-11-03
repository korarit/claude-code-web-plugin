---
description: Start the claude-web chat UI (single-port API + web). Usage: /web-start [--port <n>]
---

Start the local claude-web server using the plugin script. It serves the Elysia API and the built web UI on the same port.

1. Read the port from `$ARGUMENTS` (e.g. `--port 4000`, `--port=4000`, or a bare number). Default: `3000`.
2. Run this exact command (replace `<port>` with the parsed port):

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/start-web.sh --port <port>
```

3. Report the URL `http://localhost:<port>` to the user.

Rules:

- Run the server in the background so the session stays usable.
- Never commit credentials; the server reuses this machine's existing `claude` login.
- This plugin is for personal local use only. Do not expose someone else's Pro/Max subscription to other users.
