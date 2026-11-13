# WorktreeModal Retains Stale Merge Success Banner Upon Closing and Re-opening

## 1. Problem Statement / Reproduction

- **Group / Harness / Scope**: Group 8: Git Worktree Lifecycle (`WorktreeModal`)
- **Category**: `ux-confusing`
- **Severity**: Low

### Steps to Reproduce
1. In `WorktreeModal`, merge a worktree using `Merge & Cleanup`.
2. The green success notice appears: `Merged "<branch>" into "main".`
3. Close `WorktreeModal` (via close button or Escape).
4. Do any other action, or immediately click `Worktrees` in the composer or via Command Palette (`Ctrl+K`) to re-open `WorktreeModal`.
5. Observe the top of the dialog.

### Actual Behavior
- The green banner `Merged "<branch>" into "main".` is still displayed at the top of the modal.
- The success notice persists across open/close cycles because `mergeNotice` is stored in component local state (`useState<string | null>(null)`) without being cleared when the dialog `open` prop transitions to false or true.

### Expected Behavior
- Opening the modal afresh should display a clean dialog without stale notices from prior merge actions performed in previous sessions or dialog openings.

### Artifacts & Screenshots
- Stale notice visible on re-open: [06-worktree-merged-and-cleaned.png](file:///tmp/e2e-harness-full/artifacts/group8-worktree-lifecycle/06-worktree-merged-and-cleaned.png)

---

## 2. Root Cause Hypothesis

In `apps/web/src/features/chat/components/WorktreeModal.tsx:47`:
```tsx
const [mergeNotice, setMergeNotice] = useState<string | null>(null);
```
`mergeNotice` is only set to `null` inside `handleCreate`, `handleMerge`, and `handleRemove`.
There is no `useEffect` resetting `mergeNotice` and `confirmAction` when `open` becomes `false` or when `open` becomes `true`.
Because `WorktreeModal` is rendered in `WorkspacePage.tsx:482` unconditionally (with `open={worktreeModalOpen}` controlling its visibility in `<Dialog open={open}>`), the component remains mounted in the React tree and preserves its internal state between openings.

---

## 3. Proposed Fix(es)

In `apps/web/src/features/chat/components/WorktreeModal.tsx`:
Add an effect to reset dialog-specific transient state whenever `open` changes:
```tsx
useEffect(() => {
  if (!open) {
    setMergeNotice(null);
    setConfirmAction(null);
  }
}, [open]);
```

---

## 4. File-Level Change Plan

1. `apps/web/src/features/chat/components/WorktreeModal.tsx`:
   - Add `useEffect` resetting `mergeNotice` and `confirmAction` when `open` is false.

---

## 5. Test / Verification Plan

- Perform a merge in `WorktreeModal` -> observe success notice.
- Close modal.
- Re-open modal -> verify the dialog is clean with no stale green banner.
