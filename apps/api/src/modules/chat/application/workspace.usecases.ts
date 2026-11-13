import type { UploadImageResponse, WorkspaceFileEntry } from "@contracts/chat";
import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import { ChatBadRequestError } from "../domain/errors.ts";
import type { WorkspacePort } from "./ports.ts";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB

export class ListWorkspaceFilesUsecase {
  constructor(
    private readonly workspace: WorkspacePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: {
    cwd?: string;
    query?: string;
    limit?: number;
  }): Promise<Result<WorkspaceFileEntry[], AppError>> {
    const cwd = input.cwd?.trim() || this.defaultCwd;
    const files = await this.workspace.listFiles(cwd, input.query, input.limit ?? 50);
    return ok(files);
  }
}

export class UploadImageUsecase {
  constructor(
    private readonly workspace: WorkspacePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: {
    cwd?: string;
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
  }): Promise<Result<UploadImageResponse, AppError>> {
    if (input.bytes.byteLength === 0) {
      return err(new ChatBadRequestError("uploaded image is empty"));
    }
    if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
      return err(new ChatBadRequestError("uploaded image exceeds 10MB limit"));
    }
    if (input.mimeType && !input.mimeType.startsWith("image/")) {
      return err(new ChatBadRequestError("only image uploads are supported"));
    }

    const cwd = input.cwd?.trim() || this.defaultCwd;
    const saved = await this.workspace.saveImage(cwd, input.filename, input.bytes);
    return ok(saved);
  }
}
