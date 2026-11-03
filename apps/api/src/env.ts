export interface Env {
  port: number;
}

export const DEFAULT_PORT = 3000;

export function parseEnv(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Env {
  let port = Number(env["PORT"] ?? DEFAULT_PORT);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === "--port" || arg === "-p") && argv[i + 1] !== undefined) {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${port}. Use --port <1-65535> or PORT env.`);
  }
  return { port };
}
