# Worktree Remove Lacks Force-Delete Option for Dirty Worktrees and Leaves Orphaned Branches

## 1. Problem Statement / Reproduction

- **Group / Harness / Scope**: Group 8: Git Worktree Lifecycle (`WorktreeModal`, `WorkspacePage`, `remove-worktree.usecase`)
- **Category**: `error-handling`
- **Severity**: Medium

### Steps to Reproduce
1. Create a worktree `feat/dirty-wt` in `WorktreeModal`.
2. Start a session or make changes in that worktree (e.g. creating an untracked file or editing a tracked file without committing).
3. Open `WorktreeModal`, locate `feat/dirty-wt`, and click `Remove` -> `Confirm Remove`.
4. Observe the API response and modal UI.

### Actual Behavior
- The backend executes `git worktree remove` without `--force`.
- Git rejects the command with error:
  `fatal: '<path>' contains modified or untracked files, use --force to delete it`.
- The modal displays this raw git error in the red error banner.
- However, there is NO checkbox or secondary confirmation (e.g. "Force delete untracked/modified changes") in the UI.
- The user is completely blocked from removing the worktree in the web application and must manually open a terminal shell to run `git worktree remove --force <path>`.
- Additionally, when `onRemove` executes successfully on clean worktrees, it never passes `deleteBranch: true`. The branch `feat/dirty-wt` remains permanently in git (`.git/refs/heads/`), cluttering the repository.

### Expected Behavior
- When `Remove` is clicked, the UI should offer an option or confirmation dialog allowing the user to force-remove the worktree even if it contains uncommitted files.
- The UI should also offer an option (or default) to delete the associated git branch upon worktree removal.

---

## 2. Root Cause Hypothesis

1. **`WorkspacePage.tsx` does not pass `force` or `deleteBranch`**:
   In `apps/web/src/features/chat/components/WorkspacePage.tsx:502-506`:
   ```ts
   onRemove={async (worktreePath) => {
     const res = await worktreesState.remove({ worktreePath });
     resetRemovedWorktreeCwd(worktreePath);
     return res;
   }}
   ```
   `worktreesState.remove` receives only `{ worktreePath }`. `force` and `deleteBranch` are omitted and default to `false`.

2. **`WorktreeModal.tsx` confirmation has no options**:
   In `apps/web/src/features/chat/components/WorktreeModal.tsx:222-264`:
   When `confirmAction.kind === "remove"`, only a single "Confirm Remove" button is rendered. There is no checkbox for "Force removal (discard uncommitted files)" or "Delete branch".

3. **Backend `RemoveWorktreeUsecase` supports `force` and `deleteBranch`, but the frontend never invokes them**:
   In `apps/api/src/modules/workspace/application/remove-worktree.usecase.ts:38-42`:
   ```ts
   await this.git.removeWorktree(repoRoot, match.path, Boolean(input.force));
   if (input.deleteBranch && match.branch) {
     await this.git.deleteBranch(repoRoot, match.branch, Boolean(input.force)).catch(() => {});
   }
   ```
   The backend logic already supports both flags, but the frontend contracts and UI never provide them.

---

## 3. Proposed Fix(es)

- **Option A (Recommended)**:
  1. In `WorktreeModal.tsx`, add a checkbox in the remove confirmation box: `[x] Delete branch ({{branch}})` and `[ ] Force delete (discard uncommitted changes)`.
  2. If a removal attempt fails due to modified/untracked files, display a button: "Force Remove" directly inside the error banner to allow 1-click recovery.
  3. Pass `force` and `deleteBranch` through `onRemove` in `WorktreeModalProps`, `useWorktrees.remove`, and `WorkspacePage.tsx`.

---

## 4. File-Level Change Plan

1. `apps/web/src/features/chat/components/WorktreeModal.tsx`:
   - Add state for `forceRemove` and `deleteBranch`.
   - Update `onRemove: (worktreePath: string, options?: { force?: boolean; deleteBranch?: boolean }) => Promise<unknown>`.
2. `apps/web/src/features/chat/components/WorkspacePage.tsx`:
   - Pass options to `worktreesState.remove({ worktreePath, force, deleteBranch })`.
3. `apps/web/src/lib/i18n/locales/en.ts`:
   - Add translation strings: `worktreeForceRemove`, `worktreeDeleteBranchCheckbox`.

---

## 5. Test / Verification Plan

- Create a worktree with an uncommitted modified file.
- Click `Remove` in `WorktreeModal`.
- Verify the user can select force remove, and that the worktree directory and branch are successfully cleaned up without error.
