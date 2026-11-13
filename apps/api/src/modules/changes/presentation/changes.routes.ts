import { Elysia, t } from "elysia";
import type { FileDiffMode } from "@contracts/changes";
import { okResponse } from "@contracts/http";
import type { ChangesRepository } from "../domain/changes.repository.port.ts";
import {
  GetFileDiffUsecase,
  ListSessionChangesUsecase,
  ReadRawFileUsecase,
  RevertFileChangeUsecase,
  type GitWorkspacePort,
  type SessionLookupPort,
  type SnapshotStorePort,
  type WorkspaceFilePort,
} from "../application/index.ts";

export interface ChangesRoutesDeps {
  sessions: SessionLookupPort;
  repo: ChangesRepository;
  snapshots: SnapshotStorePort;
  files: WorkspaceFilePort;
  git: GitWorkspacePort;
  defaultCwd: string;
}

export function changesRoutes(deps: ChangesRoutesDeps) {
  const listChanges = new ListSessionChangesUsecase(
    deps.sessions,
    deps.repo,
    deps.git,
    deps.defaultCwd,
  );
  const getFileDiff = new GetFileDiffUsecase(
    deps.sessions,
    deps.repo,
    deps.snapshots,
    deps.files,
    deps.git,
    deps.defaultCwd,
  );
  const readRawFile = new ReadRawFileUsecase(deps.sessions, deps.files, deps.defaultCwd);
  const revertFile = new RevertFileChangeUsecase(
    deps.sessions,
    deps.repo,
    deps.snapshots,
    deps.files,
    deps.git,
    deps.defaultCwd,
  );

  return new Elysia()
    .get("/api/workspace/changes", async ({ query }) => {
      return okResponse(await listChanges.listWorkspaceGitChanges(query["cwd"] || undefined));
    })
    .get("/api/workspace/changes/diff", async ({ query }) => {
      const result = await getFileDiff.getWorkspaceGitDiff(
        query["cwd"] || undefined,
        query["path"] ?? "",
      );
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .get("/api/workspace/files/raw", async ({ query }) => {
      const result = await readRawFile.readWorkspaceRawFile(
        query["cwd"] || undefined,
        query["path"] ?? "",
      );
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .get("/api/chat/sessions/:id/changes", async ({ params, query }) => {
      const mode: FileDiffMode = query["mode"] === "git" ? "git" : "session";
      const result = await listChanges.execute({
        sessionId: params.id,
        mode,
      });
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .get("/api/chat/sessions/:id/changes/diff", async ({ params, query }) => {
      const mode: FileDiffMode = query["mode"] === "git" ? "git" : "session";
      const result = await getFileDiff.execute({
        sessionId: params.id,
        path: query["path"] ?? "",
        mode,
        revId: query["revId"] || undefined,
      });
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .get("/api/chat/sessions/:id/files/raw", async ({ params, query }) => {
      const result = await readRawFile.execute({
        sessionId: params.id,
        path: query["path"] ?? "",
      });
      if (!result.ok) throw result.error;
      return okResponse(result.value);
    })
    .post(
      "/api/chat/sessions/:id/changes/revert",
      async ({ params, body }) => {
        const result = await revertFile.execute({
          sessionId: params.id,
          path: body.path,
          mode: body.mode as FileDiffMode | undefined,
        });
        if (!result.ok) throw result.error;
        return okResponse(result.value);
      },
      {
        body: t.Object({
          path: t.String(),
          mode: t.Optional(t.Union([t.Literal("session"), t.Literal("git")])),
        }),
      },
    );
}
