import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeNativeImporterPort } from "../application/ports.ts";
import { buildOpenCodeImportPayload } from "../application/verbatim-formatter.ts";
import type { CanonicalEvent, CanonicalSession } from "../domain/canonical-session.entity.ts";

export type OpenCodeImportExecFn = (
  cmd: string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function defaultOpenCodeExec(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export class OpenCodeNativeImporterAdapter implements OpenCodeNativeImporterPort {
  private readonly exec: OpenCodeImportExecFn;
  private readonly opencodeBin: string;
  private readonly enabled: boolean;

  constructor(options?: {
    enabled?: boolean;
    opencodeBin?: string;
    exec?: OpenCodeImportExecFn;
  }) {
    this.enabled = options?.enabled ?? false;
    this.opencodeBin = options?.opencodeBin ?? "opencode";
    this.exec = options?.exec ?? defaultOpenCodeExec;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async importSession(params: {
    cwd: string;
    canonicalSession: CanonicalSession;
    events: CanonicalEvent[];
  }): Promise<{ externalSessionId: string } | null> {
    if (!this.enabled) return null;

    const externalSessionId = `oc_sync_${params.canonicalSession.canonicalSessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const payload = buildOpenCodeImportPayload({
      canonicalSession: params.canonicalSession,
      events: params.events,
      externalSessionId,
    });

    const dir = mkdtempSync(join(tmpdir(), "hw-oc-import-"));
    const jsonPath = join(dir, "export.json");
    try {
      writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
      const res = await this.exec([this.opencodeBin, "import", jsonPath], params.cwd);
      if (res.exitCode !== 0) return null;
      return { externalSessionId };
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
