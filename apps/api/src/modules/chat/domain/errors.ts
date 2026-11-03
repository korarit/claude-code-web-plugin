import { AppError } from "@core/errors";

export class ChatBadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}

export class ClaudeSpawnError extends AppError {
  constructor(message: string) {
    super("CLAUDE_SPAWN_FAILED", message, 500);
  }
}
