import { Elysia, t } from "elysia";
import { okResponse } from "@contracts/http";
import {
  CreateWorktreeUsecase,
  ListWorktreesUsecase,
  MergeWorktreeUsecase,
  RemoveWorktreeUsecase,
  type GitWorktreePort,
} from "../application/index.ts";

export interface WorkspaceRoutesDeps {
  git: GitWorktreePort;
  defaultCwd: string;
}

export function workspaceRoutes(deps: WorkspaceRoutesDeps) {
  const listWorktrees = new ListWorktreesUsecase(deps.git, deps.defaultCwd);
  const createWorktree = new CreateWorktreeUsecase(deps.git, deps.defaultCwd);
  const removeWorktree = new RemoveWorktreeUsecase(deps.git, deps.defaultCwd);
  const mergeWorktree = new MergeWorktreeUsecase(deps.git, deps.defaultCwd);

  return new Elysia()
    .get("/api/workspace/worktrees", async ({ query }) => {
      const result = await listWorktrees.execute(query["cwd"] || undefined);
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .post(
      "/api/workspace/worktrees",
      async ({ body }) => {
        const result = await createWorktree.execute({
          cwd: body.cwd,
          branch: body.branch,
          baseBranch: body.baseBranch,
          path: body.path,
        });
        if (!result.ok) throw result.error;
        return okResponse(result.value);
      },
      {
        body: t.Object({
          cwd: t.Optional(t.String()),
          branch: t.String(),
          baseBranch: t.Optional(t.String()),
          path: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/api/workspace/worktrees/merge",
      async ({ body }) => {
        const result = await mergeWorktree.execute({
          cwd: body.cwd,
          worktreePath: body.worktreePath,
          targetBranch: body.targetBranch,
          removeAfterMerge: body.removeAfterMerge,
        });
        if (!result.ok) throw result.error;
        return okResponse(result.value);
      },
      {
        body: t.Object({
          cwd: t.Optional(t.String()),
          worktreePath: t.String(),
          targetBranch: t.Optional(t.String()),
          removeAfterMerge: t.Optional(t.Boolean()),
        }),
      },
    )
    .post(
      "/api/workspace/worktrees/remove",
      async ({ body }) => {
        const result = await removeWorktree.execute({
          cwd: body.cwd,
          worktreePath: body.worktreePath,
          force: body.force,
          deleteBranch: body.deleteBranch,
        });
        if (!result.ok) throw result.error;
        return okResponse(result.value);
      },
      {
        body: t.Object({
          cwd: t.Optional(t.String()),
          worktreePath: t.String(),
          force: t.Optional(t.Boolean()),
          deleteBranch: t.Optional(t.Boolean()),
        }),
      },
    );
}
