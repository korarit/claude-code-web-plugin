# Worktree Removal or Merge Fails to Reset Composer CWD and Breaks Git Modal

## 1. Problem Statement / Reproduction

- **Group / Harness / Scope**: Group 8: Git Worktree Lifecycle (`WorktreeModal`, `WorkspacePage`, `git-worktree.adapter`, `useWorktrees`)
- **Category**: `bug`
- **Severity**: High

### Steps to Reproduce
1. In New Session composer, click `Worktrees` button to open `WorktreeModal`.
2. Create a new worktree with branch name `feat/e2e-remove` -> worktree directory `/tmp/e2e-harness-full/.harness-worktrees/git-repo/feat-e2e-remove` is created on disk, and composer CWD updates to this worktree.
3. In composer, click `wt: feat/e2e-remove` to re-open `WorktreeModal`.
4. On `feat/e2e-remove`, click `Remove` -> click `Confirm Remove` (or on a clean worktree, click `Merge & Cleanup` -> `Confirm Merge & Cleanup`).
5. Worktree directory is removed from disk and git worktrees list.
6. Close the modal or observe the composer and modal state.
7. Observe composer CWD input (`page.getByPlaceholder("Default workspace directory")`).
8. Click `Worktrees` button to re-open `WorktreeModal`.

### Actual Behavior
- After worktree removal or merge cleanup, composer CWD remains set to the deleted worktree path:
  `/tmp/e2e-harness-full/.harness-worktrees/git-repo/feat-e2e-remove`.
- When `WorktreeModal` is re-opened, it calls `worktreesState.refresh(chat.cwd)`. Because `chat.cwd` points to a non-existent directory on disk, `git.findRepoRoot(cwd)` returns `null`, and the API returns `{ repoRoot: null, worktrees: [] }`.
- `WorktreeModal` displays a broken gray state: `"Selected directory is not a git repository."`. The "Create New Worktree" form and the main worktree card completely vanish.
- The user is permanently stuck in a broken workspace state until a full page reload or manual text edit of the CWD input.

### Expected Behavior
- When a selected worktree is removed or merged, composer CWD (`chat.cwd`) should cleanly reset to the main repository root (`/tmp/e2e-harness-full/git-repo`).
- `useWorktrees.refresh()` should be called with the repository root, not the deleted worktree path.
- Re-opening `WorktreeModal` should cleanly display the main worktree and the "Create New Worktree" form.

### Artifacts & Screenshots
- Broken modal screenshot: [07b-worktree-modal-broken-after-remove.png](file:///tmp/e2e-harness-full/artifacts/group8-worktree-lifecycle/07b-worktree-modal-broken-after-remove.png)
- Merged state with "not a git repo" warning: [06-worktree-merged-and-cleaned.png](file:///tmp/e2e-harness-full/artifacts/group8-worktree-lifecycle/06-worktree-merged-and-cleaned.png)

---

## 2. Root Cause Hypothesis

1. **`LocalGitWorktreeAdapter.findRepoRoot` identifies the worktree as its own repo root**:
   In `apps/api/src/modules/workspace/infrastructure/git-worktree.adapter.ts:25-31`:
   ```ts
   async findRepoRoot(cwd: string): Promise<string | null> {
     if (!existsSync(cwd)) return null;
     const res = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
     if (!res.ok) return null;
     const root = res.stdout.trim();
     return root || null;
   }
   ```
   Inside a git worktree, `git rev-parse --show-toplevel` returns the worktree directory itself (`.../.harness-worktrees/git-repo/feat-e2e-remove`), NOT the root of the main repository (`.../git-repo`). Thus `res.repoRoot` is set to the worktree path.

2. **`resetRemovedWorktreeCwd` falls back to the deleted path itself**:
   In `apps/web/src/features/chat/components/WorkspacePage.tsx:468-479`:
   ```ts
   const resetRemovedWorktreeCwd = useCallback(
     (removedPath: string) => {
       const fallback = worktreesState.repoRoot ?? defaultCwd ?? "";
       if (chat.cwd === removedPath) {
         chat.setCwd(fallback);
       }
       if (reviewWorktreeCwd === removedPath) {
         setReviewWorktreeCwd(undefined);
       }
     },
     [chat, defaultCwd, reviewWorktreeCwd, worktreesState.repoRoot],
   );
   ```
   Because `worktreesState.repoRoot` was pointing to `removedPath` (the worktree itself!), `fallback` evaluated to `removedPath`. Calling `chat.setCwd(fallback)` reset `chat.cwd` back to the deleted path!

3. **`useWorktrees.remove` refreshes using the deleted worktree CWD**:
   In `apps/web/src/features/chat/hooks/useWorktrees.ts:80-92`:
   ```ts
   const remove = useCallback(
     async (req: RemoveWorktreeRequest) => {
       setBusy(true);
       setError(null);
       try {
         const res = await removeWorktree({ ...req, cwd: req.cwd ?? cwd });
         await refresh(req.cwd ?? cwd);
         return res;
       } catch (e) {
         setError((e as Error).message);
         throw e;
       } finally {
         setBusy(false);
       }
     },
     [cwd, refresh],
   );
   ```
   `refresh(req.cwd ?? cwd)` calls `fetchWorktrees` with the deleted worktree path `cwd`. The backend returns `{ repoRoot: null, worktrees: [] }`, setting `repoRoot` to `null` and wiping out all worktrees from React state.

---

## 3. Proposed Fix(es)

- **Option A (Recommended: Backend + Frontend Alignment)**:
  1. In `LocalGitWorktreeAdapter.findRepoRoot`: use `git rev-parse --path-format=absolute --git-common-dir`. If `commonDir` exists and is `<path>/.git`, `dirname(commonDir)` is the actual main repository root across all worktrees. Alternatively, query `git worktree list --porcelain` where the first entry (`isMain === true`) is guaranteed to be the main repository root.
  2. In `WorkspacePage.tsx`: In `resetRemovedWorktreeCwd`, determine the fallback from the main worktree (`worktreesState.worktrees.find(w => w.isMain)?.path ?? defaultCwd ?? ""`). If `fallback === removedPath`, fall back to `defaultCwd`.
  3. In `useWorktrees.ts`: In `remove` and `merge`, after successful execution, call `refresh(mainRepoRoot)` rather than `req.cwd ?? cwd`.
- **Option B (Frontend only fallback)**:
  In `WorkspacePage.tsx`, always reset `chat.cwd` to `worktrees.find(w => w.isMain)?.path ?? defaultCwd` whenever a worktree is removed or merged.

---

## 4. File-Level Change Plan

1. `apps/api/src/modules/workspace/infrastructure/git-worktree.adapter.ts`:
   - Update `findRepoRoot(cwd)` to resolve the primary repository root via `--git-common-dir` or main worktree inspection so all worktrees report the same `repoRoot`.
2. `apps/web/src/features/chat/components/WorkspacePage.tsx`:
   - In `resetRemovedWorktreeCwd`, locate the main worktree path (`worktreesState.worktrees.find(w => w.isMain)?.path`) and fall back to `defaultCwd`. Ensure it never resets to `removedPath`.
3. `apps/web/src/features/chat/hooks/useWorktrees.ts`:
   - Pass the primary `repoRoot` or fallback CWD to `refresh()` after removing or merging a worktree.

---

## 5. Test / Verification Plan

- Run `/tmp/e2e-pw-runner/group8-worktree-lifecycle.ts`.
- Verify Step 5b:
  - Create worktree `feat/e2e-remove`.
  - Remove worktree via `WorktreeModal`.
  - Verify `chat.cwd` resets to `/tmp/e2e-harness-full/git-repo`.
  - Re-open `WorktreeModal` and verify main worktree and creation form are cleanly displayed without "Selected directory is not a git repository" warning.
