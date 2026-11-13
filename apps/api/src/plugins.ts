import { Elysia } from "elysia";
import { AppError } from "@core/errors";
import { errResponse } from "@contracts/http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export interface SecurityOptions {
  host: string;
  token: string;
}

export function errorPlugin(security?: SecurityOptions) {
  const requireTokenAlways = security ? !LOOPBACK_HOSTS.has(security.host) : false;

  return (app: Elysia) =>
    app
      .onError(({ error, set }) => {
        if (error instanceof AppError) {
          set.status = error.status as 400;
          return errResponse(error.code, error.message);
        }
        return errResponse("INTERNAL", "internal server error");
      })
      .onBeforeHandle(({ request, path, set }) => {
        if (!path.startsWith("/api/")) return;

        const origin = request.headers.get("origin");
        if (origin) {
          if (!isLoopbackOrigin(origin)) {
            throw new AppError("FORBIDDEN", "cross-origin requests are not allowed", 403);
          }
          set.headers["access-control-allow-origin"] = origin;
          set.headers["vary"] = "Origin";
        }

        if (!security || path === "/api/health") return;

        const headerToken =
          request.headers.get("x-harness-token") ??
          request.headers.get("x-claude-web-token") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        if (headerToken !== undefined && headerToken !== security.token) {
          throw new AppError("UNAUTHORIZED", "invalid local access token", 401);
        }
        if (requireTokenAlways && headerToken !== security.token) {
          throw new AppError("UNAUTHORIZED", "local access token required", 401);
        }
      });
}
