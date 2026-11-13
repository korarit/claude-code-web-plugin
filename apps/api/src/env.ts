import { homedir } from "node:os";
import { join } from "node:path";

export interface Env {
  host: string;
  port: number;
  harnessHome: string;
  claudeHome: string;
  token: string;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

export function parseEnv(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Env {
  let host = env["HOST"] ?? DEFAULT_HOST;
  let port = Number(env["PORT"] ?? DEFAULT_PORT);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === "--port" || arg === "-p") && argv[i + 1] !== undefined) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--host" && argv[i + 1] !== undefined) {
      host = argv[++i]!;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${port}. Use --port <1-65535> or PORT env.`);
  }

  const home = homedir();
  const harnessHome = env["HARNESS_WEB_HOME"] ?? join(home, ".harness-web");
  const claudeHome = env["CLAUDE_HOME"] ?? join(home, ".claude");
  const token = env["HARNESS_WEB_TOKEN"] ?? globalThis.crypto.randomUUID();

  return { host, port, harnessHome, claudeHome, token };
}
