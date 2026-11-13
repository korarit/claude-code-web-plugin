import type { RawFileResponse } from "@contracts/changes";
import { err, ok, type Result } from "@core/result";
import type { AppError } from "@core/errors";
import { decodePreviewText } from "../domain/diff.ts";
import { ChangeBadRequestError, ChangeNotFoundError } from "../domain/errors.ts";
import type { SessionLookupPort, WorkspaceFilePort } from "./ports.ts";

export class ReadRawFileUsecase {
  constructor(
    private readonly sessions: SessionLookupPort,
    private readonly files: WorkspaceFilePort,
    private readonly defaultCwd: string,
  ) {}

  async execute(input: {
    sessionId: string;
    path: string;
  }): Promise<Result<RawFileResponse, AppError>> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) return err(new ChangeNotFoundError(`Session not found: ${input.sessionId}`));

    const rawPath = input.path?.trim();
    if (!rawPath) return err(new ChangeBadRequestError("path query parameter is required"));

    const cwd = session.cwd || this.defaultCwd;
    let resolved;
    try {
      resolved = await this.files.resolveSafePath(cwd, rawPath);
    } catch (e) {
      return err(e as AppError);
    }

    const bytes = await this.files.readFileBytes(resolved.absPath);
    if (bytes === null) {
      return err(new ChangeNotFoundError(`File not found: ${resolved.relPath}`));
    }

    const decoded = decodePreviewText(bytes);
    return ok({
      path: resolved.relPath,
      content: decoded.text,
      isBinary: decoded.isBinary,
      truncated: decoded.truncated,
      size: bytes.byteLength,
    });
  }
}
