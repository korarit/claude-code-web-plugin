import { AppError } from "@core/errors";

export class AgentNotFoundError extends AppError {
  constructor(sessionId: string, agentId: string) {
    super("NOT_FOUND", `Agent "${agentId}" not found in session "${sessionId}"`, 404);
  }
}

export class AgentSessionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super("NOT_FOUND", `Session not found: ${sessionId}`, 404);
  }
}
