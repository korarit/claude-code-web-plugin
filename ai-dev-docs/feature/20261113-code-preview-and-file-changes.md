# 20261113 — Session Code Preview, File Changes & Diff Viewer (Phase 3)

> Plan Reference: [phase-03-code-preview-and-file-changes.md](../plan/phase-03-code-preview-and-file-changes.md)  
> UI Concept: [ui-concept.md](../arc/ui-concept.md)  
> Code Structure: [code-structure.md](../code-structure.md)  
> Date (UTC): 2026-11-13

## 1. Goal / Background

Phase 3 adds real-time session-scoped file change tracking, workspace git diff inspection, code preview, and safe file revert directly in the Web UI—ensuring multiple concurrent sessions in the same repository keep their edited file histories isolated while also allowing inspection of indirect `Bash` changes via git.

## 2. Implemented Changes

### `packages/core` & `packages/contracts`
- Added `RevisionId` / `newRevisionId()` in `packages/core/src/ids.ts`.
- Added `packages/contracts/src/changes.ts`: `FileChangeStatus`, `FileEditAttribution`, `FileEditRevision`, `SessionFileChange`, `SessionChangesResponse`, `FileDiffResponse`, `RawFileResponse`, `RevertFileRequest`, `RevertFileResponse`.
- Extended `ChatEventType` with `"file_changed"` and `ChatStreamEvent` with `fileChange` and `model`.

### `apps/api` — `changes` Bounded Context + `chat` Integration
- **Domain (`apps/api/src/modules/changes/domain/`):**
  - Pure LCS line-diff engine + unified diff builder (`diff.ts`), binary & 256 KB preview truncation checks, model label normalizer.
  - `TrackedFileRecord` / `TrackedRevisionRecord` entity helpers (`change-record.entity.ts`).
  - `ChangesRepository` port (`changes.repository.port.ts`) and typed `AppError` subclasses (`errors.ts`).
- **Application (`apps/api/src/modules/changes/application/`):**
  - `RecordToolChangeUsecase`: captures baseline & per-revision snapshots on `PreToolUse` / `.jsonl` `tool_use`, computes cumulative & per-revision `+additions/-deletions` on `PostToolUse` / `.jsonl` `tool_result` (deduplicated by `toolUseId`), attaches `{ harnessId, model, agentId }`, and emits `"file_changed"` SSE events.
  - `ListSessionChangesUsecase`, `GetFileDiffUsecase`, `ReadRawFileUsecase`, `RevertFileChangeUsecase`.
- **Infrastructure (`apps/api/src/modules/changes/infrastructure/`):**
  - `FileChangesRepository`, `FileSnapshotStore`, `LocalWorkspaceFilesAdapter` (with `realpathSync` symlink-escape and `../` traversal protection), `LocalGitWorkspaceAdapter`.
- **Presentation (`apps/api/src/modules/changes/presentation/changes.routes.ts`):**
  - `GET /api/chat/sessions/:id/changes?mode=session|git`
  - `GET /api/chat/sessions/:id/changes/diff?path=...&mode=session|git&revId=...`
  - `GET /api/chat/sessions/:id/files/raw?path=...`
  - `POST /api/chat/sessions/:id/changes/revert`
- **Phase 2 Boundary Cleanup:** Removed direct `infrastructure` imports from `apps/api/src/modules/chat/presentation/chat.routes.ts` and enabled `ws: true` in `apps/web/vite.config.ts`.

### `apps/web`
- Root-level `useChanges` hook in `WorkspacePage.tsx` (preserving selected file, diff mode, and live `"file_changed"` SSE updates across `1280px` viewport transitions).
- `ChangesPanel.tsx` & `DiffViewer.tsx` supporting Unified Diff, Side-by-Side Diff, Full File Preview, zero-dep syntax highlighting (`lib/syntax.tsx`), Session vs All Git toggle, contributor filter (`harnessId`/`model`/`agentId`), Cumulative vs Per-Revision selector, Copy Path/Code, and Revert confirmation modal.
- Inline File Pills in `ToolCallBlock.tsx` / `ChatPanel.tsx` that jump straight to the edited file/revision in `ChangesPanel`.
- Updated `DesktopShell.tsx` (resizable Right Inspector with `Changes (N)` and `Terminal` tabs) and `CompactShell.tsx` (Bottom Bar with `Chat`, `Changes (N)`, `Terminal` tabs, defaulting to Unified Diff).

## 3. Verification
- `apps/api/test/phase3-code-preview-and-changes.test.ts` (PreToolUse/PostToolUse snapshots, `"file_changed"` SSE, model switch per-revision diff, 2-session isolation, path traversal & symlink escape `403`, `All Git Changes`, and session/git revert).
- Full suite `bun test` (18 pass, 0 fail), `bun run typecheck`, `bun run build`, and DDD boundary checks all pass.
