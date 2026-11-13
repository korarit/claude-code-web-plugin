export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "CLAUDE_SPAWN_FAILED"
  | "CLAUDE_FAILED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? defaultStatus(code);
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "BAD_REQUEST":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "CLAUDE_SPAWN_FAILED":
    case "CLAUDE_FAILED":
    case "INTERNAL":
      return 500;
  }
}
