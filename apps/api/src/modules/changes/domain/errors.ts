import { AppError } from "@core/errors";

export class InvalidFilePathError extends AppError {
  constructor(path: string, reason = "path escapes session workspace") {
    super("FORBIDDEN", `Access denied for path "${path}": ${reason}`, 403);
  }
}

export class ChangeBadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}

export class ChangeNotFoundError extends AppError {
  constructor(message: string) {
    super("NOT_FOUND", message, 404);
  }
}

export class GitWorkspaceError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}
