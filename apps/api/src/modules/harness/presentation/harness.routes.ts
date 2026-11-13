import { Elysia } from "elysia";
import { okResponse } from "@contracts/http";
import { HarnessRegistry, ListHarnessesUsecase } from "../application/index.ts";

export interface HarnessRoutesDeps {
  registry: HarnessRegistry;
}

export function harnessRoutes(deps: HarnessRoutesDeps) {
  const listHarnesses = new ListHarnessesUsecase(deps.registry);

  return new Elysia().get("/api/harnesses", async () => {
    const result = await listHarnesses.execute();
    if (!result.ok) throw result.error;
    return okResponse({ harnesses: result.value });
  });
}
