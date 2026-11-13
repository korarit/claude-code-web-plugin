import { AppError } from "@core/errors";

export class ChatBadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}

export class ApiKeyNotConfiguredError extends AppError {
  constructor() {
    super(
      "BAD_REQUEST",
      "ANTHROPIC_API_KEY is not configured in the API server environment. Set it before starting an API Key mode session.",
      400,
    );
  }
}

export class SessionNotFoundError extends AppError {
  constructor(id: string) {
    super("NOT_FOUND", `session not found: ${id}`, 404);
  }
}

export class InteractionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super("NOT_FOUND", `no pending interaction found for session ${sessionId}`, 404);
  }
}

export class SessionBusyError extends AppError {
  constructor(id: string, status: string) {
    super("CONFLICT", `session ${id} is currently ${status}`, 409);
  }
}

export class MirrorSessionError extends AppError {
  constructor(id: string) {
    super(
      "CONFLICT",
      `session ${id} is in read-only mirror mode. Click "Continue in Web" to resume it interactively.`,
      409,
    );
  }
}

export class SessionNotRunningError extends AppError {
  constructor(id: string) {
    super("CONFLICT", `session ${id} is not running in tmux`, 409);
  }
}

export class TmuxNotAvailableError extends AppError {
  constructor(
    message = "tmux is not installed or not found on PATH. Install it (e.g. `sudo apt install tmux` or `brew install tmux`) to run interactive sessions.",
  ) {
    super("SERVICE_UNAVAILABLE", message, 503);
  }
}

export class ClaudeSpawnError extends AppError {
  constructor(message: string) {
    super("CLAUDE_SPAWN_FAILED", message, 500);
  }
}
