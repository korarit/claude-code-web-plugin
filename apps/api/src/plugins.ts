import { Elysia } from "elysia";
import { AppError } from "@core/errors";
import { errResponse } from "@contracts/http";

export function errorPlugin(app: Elysia) {
  return app
    .onError(({ error, set }) => {
      if (error instanceof AppError) {
        set.status = error.status as 400;
        return errResponse(error.code, error.message);
      }
      return errResponse("INTERNAL", "internal server error");
    })
    .onAfterHandle(({ set }) => {
      set.headers["access-control-allow-origin"] = "*";
    });
}
