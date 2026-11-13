import { AppError } from "@core/errors";

export class UnknownHarnessError extends AppError {
  constructor(harnessId: string) {
    super("BAD_REQUEST", `Unknown harness: ${harnessId}`, 400);
  }
}

export class HarnessNotAvailableError extends AppError {
  constructor(harnessId: string, binary: string) {
    super(
      "CONFLICT",
      `Harness '${harnessId}' is not available on this machine (missing '${binary}' binary).`,
      409,
    );
  }
}

export class HarnessSpawnError extends AppError {
  constructor(harnessId: string, message: string) {
    super("INTERNAL", `${harnessId}: ${message}`, 500);
  }
}

export class OpenCodeServerError extends AppError {
  constructor(message: string) {
    super("INTERNAL", `OpenCode server error: ${message}`, 502);
  }
}
