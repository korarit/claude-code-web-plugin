import { homedir } from "node:os";
import { join } from "node:path";

export interface Env {
  host: string;
  port: number;
  harnessHome: string;
  claudeHome: string;
  agyCliHome: string;
  agyIdeHome: string;
  enableAgyIdeDiscovery: boolean;
  opencodeDataHome: string;
  opencodeServerUrl?: string;
  token: string;
  anthropicApiKey?: string;
  concurrencySoftLimit?: number;
  permissionHookTimeoutMs?: number;
  syncByteThreshold?: number;
  syncTurnThreshold?: number;
  opencodeNativeImport?: boolean;
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
  const agyCliHome = env["AGY_CLI_HOME"] ?? join(home, ".gemini", "antigravity-cli");
  const agyIdeHome = env["AGY_IDE_HOME"] ?? join(home, ".gemini", "antigravity");
  const enableAgyIdeDiscovery = env["HARNESS_AGY_IDE_DISCOVERY"] !== "false";
  const opencodeDataHome = env["OPENCODE_DATA_HOME"] ?? join(home, ".local", "share", "opencode");
  const opencodeServerUrl = env["OPENCODE_SERVER_URL"]?.trim() || undefined;
  const token = env["HARNESS_WEB_TOKEN"] ?? globalThis.crypto.randomUUID();
  const anthropicApiKey = env["ANTHROPIC_API_KEY"]?.trim() || undefined;
  const concurrencySoftLimit = Math.max(1, Number(env["HARNESS_CONCURRENCY_LIMIT"] ?? 3) || 3);
  const permissionHookTimeoutMs = Math.max(
    1_000,
    Number(env["HARNESS_PERMISSION_TIMEOUT_MS"] ?? 55_000) || 55_000,
  );
  const syncByteThreshold = Math.max(
    512,
    Number(env["HARNESS_SYNC_BYTE_THRESHOLD"] ?? 20 * 1024) || 20 * 1024,
  );
  const syncTurnThreshold = Math.max(
    2,
    Number(env["HARNESS_SYNC_TURN_THRESHOLD"] ?? 40) || 40,
  );
  const opencodeNativeImport = env["HARNESS_OPENCODE_NATIVE_IMPORT"] === "true";

  return {
    host,
    port,
    harnessHome,
    claudeHome,
    agyCliHome,
    agyIdeHome,
    enableAgyIdeDiscovery,
    opencodeDataHome,
    opencodeServerUrl,
    token,
    anthropicApiKey,
    concurrencySoftLimit,
    permissionHookTimeoutMs,
    syncByteThreshold,
    syncTurnThreshold,
    opencodeNativeImport,
  };
}
