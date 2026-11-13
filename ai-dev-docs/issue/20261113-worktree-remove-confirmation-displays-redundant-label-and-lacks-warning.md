# Worktree Remove Confirmation Prompt Displays Redundant Text and Lacks Deletion Consequence Warning

## 1. Problem Statement / Reproduction

- **Group / Harness / Scope**: Group 8: Git Worktree Lifecycle (`WorktreeModal`, `en.ts`)
- **Category**: `ux-confusing`
- **Severity**: Low / Medium

### Steps to Reproduce
1. In `WorktreeModal`, find any non-main worktree.
2. Click the `Remove` button.
3. Observe the amber confirmation box that expands inline.

### Actual Behavior
- The confirmation box renders:
  ```html
  <span class="text-[10px] text-[var(--text-primary)]">Confirm Remove</span>
  <button ...>Confirm Remove</button>
  <button ...>Cancel</button>
  ```
- Two identical labels `"Confirm Remove"` sit side-by-side.
- In contrast, when `Merge & Cleanup` is clicked, the label clearly explains:
  `Merges "<source>" into main and deletes this worktree.`
- For `Remove`, there is zero descriptive note informing the user that this action permanently deletes the worktree folder from disk and cannot be undone.

### Expected Behavior
- The prompt label should explain what the action does, e.g.:
  `"Permanently deletes this worktree directory from disk."` (e.g. `worktreeConfirmRemoveNote`).
- The button should say `"Delete Worktree"` or `"Confirm Remove"`, eliminating the redundant label duplication.

### Artifacts & Screenshots
- Mobile screenshot showing redundant text: [08-mobile-worktree-modal.png](file:///tmp/e2e-harness-full/artifacts/group8-worktree-lifecycle/08-mobile-worktree-modal.png)

---

## 2. Root Cause Hypothesis

1. **`WorktreeModal.tsx:225-230` falls back to `worktreeConfirmRemove` for the note span**:
   ```tsx
   <span className="text-[10px] text-[var(--text-primary)]">
     {confirmAction.kind === "merge"
       ? t("worktreeConfirmMergeNote", {
           source: wt.branch ?? wt.head.slice(0, 7),
         })
       : t("worktreeConfirmRemove")}
   </span>
   ```
2. **Missing translation key `worktreeConfirmRemoveNote`**:
   In `apps/web/src/lib/i18n/locales/en.ts:190-195`:
   `worktreeConfirmMergeNote` exists, but there is no `worktreeConfirmRemoveNote`.
   As a result, `t("worktreeConfirmRemove")` ("Confirm Remove") is reused for both the prompt message and the action button.

---

## 3. Proposed Fix(es)

1. Add `worktreeConfirmRemoveNote` to `en.ts`:
   `worktreeConfirmRemoveNote: "Permanently deletes this worktree directory from disk.",`
2. In `WorktreeModal.tsx:229`, use `t("worktreeConfirmRemoveNote")` instead of `t("worktreeConfirmRemove")`.

---

## 4. File-Level Change Plan

1. `apps/web/src/lib/i18n/locales/en.ts`:
   - Add `worktreeConfirmRemoveNote: "Permanently deletes this worktree directory from disk."`
2. `apps/web/src/features/chat/components/WorktreeModal.tsx`:
   - Replace `t("worktreeConfirmRemove")` on line 229 with `t("worktreeConfirmRemoveNote")`.

---

## 5. Test / Verification Plan

- Open `WorktreeModal`, click `Remove` on a worktree.
- Verify the amber box displays:
  `Permanently deletes this worktree directory from disk.`
  followed by `[Confirm Remove]` and `[Cancel]` buttons.
