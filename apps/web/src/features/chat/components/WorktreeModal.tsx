import { useState } from "react";
import type { GitWorktreeInfo, MergeWorktreeResponse } from "@contracts/workspace";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";

export interface WorktreeModalProps {
  open: boolean;
  repoRoot: string | null;
  worktrees: GitWorktreeInfo[];
  selectedCwd: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (branch: string, baseBranch?: string) => Promise<GitWorktreeInfo | undefined>;
  onSelectWorktree: (worktreePath: string) => void;
  onReviewDiff: (worktreePath: string) => void;
  onMerge: (worktreePath: string, removeAfterMerge: boolean) => Promise<MergeWorktreeResponse | undefined>;
  onRemove: (worktreePath: string) => Promise<unknown>;
}

/** Modal dialog for creating, selecting, reviewing, merging, and removing Git worktrees. */
export default function WorktreeModal({
  open,
  repoRoot,
  worktrees,
  selectedCwd,
  busy,
  error,
  onClose,
  onCreate,
  onSelectWorktree,
  onReviewDiff,
  onMerge,
  onRemove,
}: WorktreeModalProps) {
  const { t } = useTranslation();
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    path: string;
    kind: "merge" | "remove";
  } | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branch.trim() || busy) return;
    setMergeNotice(null);
    setConfirmAction(null);
    try {
      const created = await onCreate(branch.trim(), baseBranch.trim() || undefined);
      if (created) {
        setBranch("");
        setBaseBranch("");
        onSelectWorktree(created.path);
        onClose();
      }
    } catch {
      // Error banner is driven by useWorktrees error state.
    }
  };

  const handleMerge = async (wt: GitWorktreeInfo) => {
    setMergeNotice(null);
    setConfirmAction(null);
    try {
      const res = await onMerge(wt.path, true);
      if (res?.merged) {
        setMergeNotice(
          t("worktreeMergeSuccess", {
            source: res.sourceBranch,
            target: res.targetBranch,
          }),
        );
      }
    } catch {
      // Error banner is driven by useWorktrees error state.
    }
  };

  const handleRemove = async (wtPath: string) => {
    setMergeNotice(null);
    setConfirmAction(null);
    try {
      await onRemove(wtPath);
    } catch {
      // Error banner is driven by useWorktrees error state.
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        className="flex max-h-[85dvh] max-w-xl flex-col gap-0 overflow-hidden p-0"
        closeLabel={t("closeDialog")}
      >
        <DialogHeader className="border-b border-[var(--border-subtle)] px-4 py-3 pr-10">
          <DialogTitle>{t("worktreeModalTitle")}</DialogTitle>
          <DialogDescription>{t("worktreeModalSubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {mergeNotice && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              {mergeNotice}
            </div>
          )}

          {!repoRoot ? (
            <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4 text-center text-xs text-[var(--text-muted)]">
              {t("worktreeNotGitRepo")}
            </div>
          ) : (
            <>
              <form
                onSubmit={(e) => void handleCreate(e)}
                className="space-y-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3"
              >
                <div className="text-xs font-semibold text-[var(--text-primary)]">
                  {t("worktreeCreateTitle")}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    <span>{t("worktreeBranchLabel")}</span>
                    <input
                      type="text"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      placeholder={t("worktreeBranchPlaceholder")}
                      disabled={busy}
                      className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
                    />
                  </label>
                  <label className="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    <span>{t("worktreeBaseBranchLabel")}</span>
                    <input
                      type="text"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      placeholder={t("worktreeBaseBranchPlaceholder")}
                      disabled={busy}
                      className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--border-strong)]"
                    />
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy || !branch.trim()}>
                    {busy ? t("worktreeCreating") : t("worktreeCreateButton")}
                  </Button>
                </div>
              </form>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--text-primary)]">
                  {t("worktreeExistingTitle", { count: worktrees.length })}
                </div>
                <div className="space-y-2">
                  {worktrees.map((wt) => {
                    const isSelected = selectedCwd === wt.path;
                    return (
                      <div
                        key={wt.path}
                        className={`rounded-lg border p-3 ${
                          isSelected
                            ? "border-[var(--accent-primary)] bg-[var(--bg-elevated)]"
                            : "border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Badge className="font-mono text-[11px] font-semibold text-[var(--text-primary)]">
                              {wt.branch ?? wt.head.slice(0, 7)}
                            </Badge>
                            {wt.isMain && <Badge variant="indigo">{t("worktreeMainBadge")}</Badge>}
                            {isSelected && <Badge variant="emerald">{t("worktreeSelected")}</Badge>}
                          </div>
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            {wt.head.slice(0, 7)}
                          </span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">
                          {wt.path}
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            onClick={() => {
                              onSelectWorktree(wt.path);
                              onClose();
                            }}
                          >
                            {t("worktreeUseForSession")}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              onReviewDiff(wt.path);
                              onClose();
                            }}
                          >
                            {t("worktreeReviewDiff")}
                          </Button>
                          {!wt.isMain &&
                            (confirmAction?.path === wt.path ? (
                              <div className="flex flex-wrap items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1">
                                <span className="text-[10px] text-[var(--text-primary)]">
                                  {confirmAction.kind === "merge"
                                    ? t("worktreeConfirmMergeNote", {
                                        source: wt.branch ?? wt.head.slice(0, 7),
                                      })
                                    : t("worktreeConfirmRemove")}
                                </span>
                                <Button
                                  type="button"
                                  size="xs"
                                  disabled={busy}
                                  variant={confirmAction.kind === "merge" ? "default" : "destructive"}
                                  className={
                                    confirmAction.kind === "merge"
                                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                                      : undefined
                                  }
                                  onClick={() =>
                                    confirmAction.kind === "merge"
                                      ? void handleMerge(wt)
                                      : void handleRemove(wt.path)
                                  }
                                >
                                  {confirmAction.kind === "merge"
                                    ? busy
                                      ? t("worktreeMerging")
                                      : t("worktreeConfirmMerge")
                                    : busy
                                      ? t("worktreeRemoving")
                                      : t("worktreeConfirmRemove")}
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => setConfirmAction(null)}
                                >
                                  {t("cancel")}
                                </Button>
                              </div>
                            ) : (
                              <>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    setConfirmAction({ path: wt.path, kind: "merge" })
                                  }
                                  className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                                >
                                  {busy ? t("worktreeMerging") : t("worktreeMergeAndClean")}
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    setConfirmAction({ path: wt.path, kind: "remove" })
                                  }
                                  className="border-rose-500/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                                >
                                  {busy ? t("worktreeRemoving") : t("worktreeRemove")}
                                </Button>
                              </>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
