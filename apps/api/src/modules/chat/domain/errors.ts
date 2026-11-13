import { AppError } from "@core/errors";

export class ChatBadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}

export class SessionNotFoundError extends AppError {
  constructor(id: string) {
    super("NOT_FOUND", `session not found: ${id}`, 404);
  }
}

export class SessionBusyError extends AppError {
  constructor(id: string, status: string) {
    super("CONFLICT", `session ${id} is currently ${status}`, 409);
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
