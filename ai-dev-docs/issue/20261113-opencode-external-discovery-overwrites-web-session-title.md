# Issue: OpenCode external discovery overwrites newly created Web session title with placeholder `"OpenCode E2E Session"` (and races to spawn mirror duplicates)

## 1. Problem Statement / Reproduction
- **Group**: Group 6 (Session Sidebar, External Discovery & Session Lifecycle)
- **Harness**: `opencode`
- **Category**: `bug`
- **Steps to Reproduce**:
  1. Click `+ New Session`, select `OpenCode` harness, and send `"Hello OpenCode Web Session"`.
  2. Observe the session row title in `ACTIVE SESSIONS` and the header breadcrumb after OpenCode creates the session and completes the turn.
  3. Repeat across runs and inspect the `All Sources` filter (`OpenCode` / `opencode_server`).
- **Actual Result**:
  - Instead of displaying `"Hello OpenCode Web Session"` (`lastMessagePreview`), the Web session's title becomes `"OpenCode E2E Session"` (the OpenCode server's generic auto-title returned by `POST /session` and broadcast via `session.created` SSE).
  - Additionally, under timing races between `POST /session` SSE `session.created` and `SendMessageUsecase` saving the session, `watchExternalSessions` can also create an extra phantom `opencode_server` mirror session with title `"OpenCode E2E Session"` (observed as `Filter origin=opencode_server count: 1` in `task-94` vs `0` in `task-88`).
  - Screenshot: `/tmp/e2e-harness-full/artifacts/group6-sidebar-discovery/06-new-opencode-web-session.png`.
- **Expected Result**:
  - A Web-originated OpenCode session displays the user's prompt preview (or user-edited title) rather than a generic OpenCode server default title, and `watchExternalSessions` / `discoverSessions` never spawns a duplicate `opencode_server` mirror session for a Web-created session.

## 2. Root Cause Hypothesis
- `SendMessageUsecase.execute()` (`apps/api/src/modules/chat/application/send-message.usecase.ts` lines 171–269) calls `await this.harnessGateway.startOrResumeSession(...)` (line 172) BEFORE calling `this.sessions.save(session)` (line 269).
- Inside `OpenCodeHarnessAdapter.startOrResumeSession()` (`apps/api/src/modules/harness/infrastructure/opencode-harness.adapter.ts` lines 222–243), `POST /session` immediately triggers OpenCode's `session.created` SSE event (`opencode-driver.ts` lines 455–457) with `title: "OpenCode E2E Session"`.
- `OpenCodeHarnessAdapter.watchExternalSessions()` (`opencode-harness.adapter.ts` lines 623–640) receives `session.created` before `SendMessageUsecase` has saved `session` with `externalSessionId = created.id`, and calls `DiscoverSessionUsecase.execute()` with `origin: "opencode_server"`, `controlMode: "mirror"`, and `title: "OpenCode E2E Session"` — creating a duplicate `opencode_server` mirror row!
- Even when `SendMessageUsecase` saves first, `DiscoverSessionUsecase.execute()` (`apps/api/src/modules/chat/application/discover-session.usecase.ts` lines 92–95) runs:
  ```ts
  if (input.title && !updated.title) {
    updated = { ...updated, title: input.title };
    changed = true;
  }
  ```
  Because Web sessions intentionally leave `session.title` `undefined` (so `SessionSidebar.tsx:163` falls back to `s.lastMessagePreview`), OpenCode's generic server title (`"OpenCode E2E Session"` or `"New session - ..."`) permanently overwrites the user prompt preview in both the sidebar and header!

## 3. Proposed Fix(es)
### Option 1: Persist Web session / bind `externalSessionId` before `watchExternalSessions` can auto-create, and do not overwrite Web sessions' display title from external server default titles
- In `SendMessageUsecase`, save the initial `Session` before `startOrResumeSession` (consistent with the AGY fix plan), and pass the user's truncated prompt (or reserve `externalSessionId` as soon as `POST /session` returns, or register pending creation in `OpenCodeHarnessAdapter`) so `watchExternalSessions` ignores or updates the existing Web session rather than creating a duplicate `opencode_server` mirror.
- In `DiscoverSessionUsecase` lines 92–95, only populate `title` from `input.title` when `updated.origin !== "web"` (or when `!updated.title && !updated.lastMessagePreview`).
- Pros: Prevents both phantom `opencode_server` duplicates and ugly generic server titles overriding user prompts on Web sessions.
- Cons: Minor coordination between `SendMessageUsecase` and `OpenCodeHarnessAdapter.watchExternalSessions`.

### Option 2: Pass truncated prompt as `title` in `OpenCodeHarnessAdapter.startOrResumeSession` `POST /session` body
- Pros: OpenCode server itself stores a meaningful title.
- Cons: Does not fix the `session.created` SSE race before `this.sessions.save(session)` completes.

### Recommended: Option 1 (plus optionally Option 2)
- Reason: Fixing the save-order race and guarding `DiscoverSessionUsecase` against overwriting Web session titles solves both the duplicate `opencode_server` row and the misleading `"OpenCode E2E Session"` title.

## 4. File-Level Change Plan
- `apps/api/src/modules/chat/application/send-message.usecase.ts` (lines 134–269): Persist the Web session before `startOrResumeSession` (and clean up on spawn failure).
- `apps/api/src/modules/harness/infrastructure/opencode-harness.adapter.ts` (lines 222–243, 623–640): Track/suppress or pass prompt title on `POST /session`, and ensure `watchExternalSessions` waits/coalesces with in-flight `startOrResumeSession` creations.
- `apps/api/src/modules/chat/application/discover-session.usecase.ts` (lines 92–95): Guard `if (input.title && !updated.title && updated.origin !== "web")`.

## 5. Test / Verification Plan
- Run Playwright E2E Group 6 (`group6-sidebar-discovery.ts`):
  - Create a new Web `OpenCode` session with `"Hello OpenCode Web Session"`.
  - Verify the sidebar row displays `"Hello OpenCode Web Session"` with origin badge `Web`, and filtering by `Origin = opencode_server` does NOT show a duplicate phantom session.
