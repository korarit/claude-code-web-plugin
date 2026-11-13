import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CanonicalSyncFileWriterPort } from "../application/ports.ts";

export class LocalSyncFileWriterAdapter implements CanonicalSyncFileWriterPort {
  async writeSyncFile(params: {
    cwd: string;
    canonicalSessionId: string;
    fromSeq: number;
    toSeq: number;
    content: string;
  }): Promise<string> {
    const safeSessionId = params.canonicalSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const relPath = join(".harness-web", "sync", `${safeSessionId}-${params.fromSeq}-${params.toSeq}.md`);
    const absPath = resolve(params.cwd, relPath);
    const syncDir = resolve(params.cwd, ".harness-web", "sync");
    mkdirSync(syncDir, { recursive: true });
    writeFileSync(absPath, params.content, "utf8");
    return relPath;
  }
}
