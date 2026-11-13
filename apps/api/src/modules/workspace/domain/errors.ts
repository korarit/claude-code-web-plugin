import { AppError } from "@core/errors";

export class WorkspaceBadRequestError extends AppError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
  }
}

export class WorkspaceGitError extends AppError {
  constructor(message: string, status = 500) {
    super(status === 409 ? "CONFLICT" : status === 400 ? "BAD_REQUEST" : "INTERNAL", message, status);
  }
}

export class WorktreeNotFoundError extends AppError {
  constructor(path: string) {
    super("NOT_FOUND", `Worktree not found: ${path}`, 404);
  }
}

export class WorktreeAlreadyExistsError extends AppError {
  constructor(target: string) {
    super("CONFLICT", `Worktree or branch already exists: ${target}`, 409);
  }
}
