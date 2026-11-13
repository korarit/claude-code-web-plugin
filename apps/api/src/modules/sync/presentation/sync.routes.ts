import { Elysia, t } from "elysia";
import type { HarnessId } from "@contracts/harness";
import { okResponse } from "@contracts/http";
import { CanonicalSessionNotFoundError } from "../domain/errors.ts";
import type { CanonicalSyncService } from "../application/canonical-sync.service.ts";
import type { SwitchHarnessUsecase } from "../application/switch-harness.usecase.ts";

export interface SyncRoutesDeps {
  canonicalSync: CanonicalSyncService;
  switchHarness: SwitchHarnessUsecase;
}

export function syncRoutes(deps: SyncRoutesDeps) {
  return new Elysia()
    .get("/api/chat/sessions/:id/canonical", ({ params, query }) => {
      const limitNum = query["limit"] ? Number(query["limit"]) : undefined;
      const limit =
        limitNum !== undefined && Number.isFinite(limitNum) && limitNum > 0
          ? Math.min(2000, Math.floor(limitNum))
          : undefined;
      const result = deps.canonicalSync.getCanonicalHistory(params.id, limit);
      if (!result) throw new CanonicalSessionNotFoundError(params.id);
      return okResponse(result);
    })
    .post(
      "/api/chat/sessions/:id/switch-harness",
      async ({ params, body }) => {
        const result = await deps.switchHarness.execute({
          sessionId: params.id,
          harnessId: body.harnessId as HarnessId,
          model: body.model,
          agentProfile: body.agentProfile,
        });
        if (!result.ok) throw result.error;
        return okResponse(result.value);
      },
      {
        body: t.Object({
          harnessId: t.Union([t.Literal("claude"), t.Literal("agy"), t.Literal("opencode")]),
          model: t.Optional(t.String()),
          agentProfile: t.Optional(t.String()),
        }),
      },
    );
}
