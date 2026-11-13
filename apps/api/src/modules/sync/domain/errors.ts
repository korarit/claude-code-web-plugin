import type { HarnessId } from "@contracts/harness";
import { AppError } from "@core/errors";

export class CanonicalSessionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super("NOT_FOUND", `Canonical session not found: ${sessionId}`, 404);
  }
}

export class HarnessSwitchBusyError extends AppError {
  constructor(sessionId: string, status: string) {
    super(
      "CONFLICT",
      `Cannot switch harness while session ${sessionId} is ${status}`,
      409,
    );
  }
}

export class HarnessSwitchUnavailableError extends AppError {
  constructor(harnessId: HarnessId) {
    super(
      "BAD_REQUEST",
      `Target harness "${harnessId}" is not available on this machine`,
      400,
    );
  }
}
