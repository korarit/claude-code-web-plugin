import { existsSync } from "node:fs";

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecCommandFn = (
  cmd: string[],
  options?: { stdin?: string; cwd?: string },
) => Promise<ExecCommandResult>;

export async function defaultExec(
  cmd: string[],
  options?: { stdin?: string; cwd?: string },
): Promise<ExecCommandResult> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: options?.stdin !== undefined ? new TextEncoder().encode(options.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.cwd,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: (e as Error).message };
  }
}

export async function resolveBinaryPath(
  binary: string,
  fallbackPaths: string[] = [],
  exec: ExecCommandFn = defaultExec,
): Promise<string | null> {
  if (binary.includes("/") && existsSync(binary)) {
    return binary;
  }
  const whichRes = await exec(["which", binary]).catch(() => ({
    exitCode: 1,
    stdout: "",
    stderr: "",
  }));
  if (whichRes.exitCode === 0) {
    const found = whichRes.stdout.trim().split("\n")[0]?.trim();
    if (found) return found;
  }
  for (const candidate of fallbackPaths) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
