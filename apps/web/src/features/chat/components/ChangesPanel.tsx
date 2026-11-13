import { useState } from "react";
import type {
  FileChangeStatus,
  FileDiffMode,
  FileDiffResponse,
  RawFileResponse,
  SessionChangesSummary,
  SessionFileChange,
} from "@contracts/changes";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { DiffViewMode } from "../hooks/useChanges.ts";
import DiffViewer from "./DiffViewer.tsx";

function statusBadge(status: FileChangeStatus): { letter: string; cls: string } {
  switch (status) {
    case "added":
      return {
        letter: "A",
        cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      };
    case "deleted":
      return {
        letter: "D",
        cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
      };
    case "renamed":
      return {
        letter: "R",
        cls: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
      };
    default:
      return {
        letter: "M",
        cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      };
  }
}

export interface ChangesPanelProps {
  hasSession: boolean;
  mode: FileDiffMode;
  onModeChange: (mode: FileDiffMode) => void;
  files: SessionFileChange[];
  summary: SessionChangesSummary;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  selectedRevId: string | null;
  onSelectRevId: (revId: string | null) => void;
  selectedFile: SessionFileChange | null;
  viewMode: DiffViewMode;
  onViewModeChange: (mode: DiffViewMode) => void;
  contributorFilter: string;
  onContributorFilterChange: (filter: string) => void;
  contributorOptions: Array<{ value: string; label: string }>;
  diff: FileDiffResponse | null;
  rawFile: RawFileResponse | null;
  loadingList: boolean;
  loadingDetail: boolean;
  reverting: boolean;
  error: string | null;
  onRefresh: () => void;
  onRevert: (path: string) => Promise<void>;
  worktreeBranch?: string;
  canRevert?: boolean;
  lockGitMode?: boolean;
}

export default function ChangesPanel({
  hasSession,
  mode,
  onModeChange,
  files,
  summary,
  selectedPath,
  onSelectPath,
  selectedRevId,
  onSelectRevId,
  selectedFile,
  viewMode,
  onViewModeChange,
  contributorFilter,
  onContributorFilterChange,
  contributorOptions,
  diff,
  rawFile,
  loadingList,
  loadingDetail,
  reverting,
  error,
  onRefresh,
  onRevert,
  worktreeBranch,
  canRevert = true,
  lockGitMode = false,
}: ChangesPanelProps) {
  const { t } = useTranslation();
  const [copiedPath, setCopiedPath] = useState(false);
  const [confirmRevertPath, setConfirmRevertPath] = useState<string | null>(null);

  if (!hasSession) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-surface)] p-6 text-center text-xs text-[var(--text-muted)]">
        {t("changesSelectSession")}
      </div>
    );
  }

  const copyFilePath = async () => {
    if (!selectedPath) return;
    try {
      await navigator.clipboard.writeText(selectedPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-surface)]">
      {/* Mode + Summary + Filter bar */}
      <div className="space-y-2 border-b border-[var(--border-subtle)] p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={lockGitMode ? "git" : mode}
            onValueChange={(v) => onModeChange(v as FileDiffMode)}
          >
            <TabsList>
              {!lockGitMode && (
                <TabsTrigger value="session">{t("changesModeSession")}</TabsTrigger>
              )}
              <TabsTrigger value="git">{t("changesModeGit")}</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2 font-mono text-[11px]">
            {worktreeBranch && (
              <Badge variant="indigo">
                {t("worktreeBadge", { branch: worktreeBranch })}
              </Badge>
            )}
            <span className="text-[var(--text-secondary)]">
              {t("changesSummary", { count: summary.filesCount })}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">+{summary.totalAdditions}</span>
            <span className="text-rose-600 dark:text-rose-400">-{summary.totalDeletions}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onRefresh}
              disabled={loadingList}
              className="font-sans"
            >
              {t("changesRefresh")}
            </Button>
          </div>
        </div>

        {contributorOptions.length > 0 && (
          <select
            value={contributorFilter}
            onChange={(e) => onContributorFilterChange(e.target.value)}
            className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px] text-[var(--text-secondary)] outline-none"
          >
            <option value="all">{t("changesFilterAll")}</option>
            {contributorOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* File List */}
      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)]/50 p-1.5">
        {loadingList && files.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">
            {t("loadingText")}
          </div>
        ) : files.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">
            {mode === "git" ? t("changesEmptyGit") : t("changesEmptySession")}
          </div>
        ) : (
          <div className="space-y-0.5">
            {files.map((file) => {
              const badge = statusBadge(file.status);
              const selected = file.path === selectedPath;
              const extraContributors = Math.max(0, file.contributors.length - 1);

              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onSelectPath(file.path)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    selected
                      ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] ring-1 ring-[var(--border-strong)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]/60"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold ${badge.cls}`}
                    >
                      {badge.letter}
                    </span>
                    <span className="truncate font-mono text-[11px]">{file.path}</span>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
                    <span className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                      {file.lastEditedBy.harnessId} · {file.lastEditedBy.model}
                    </span>
                    {extraContributors > 0 && (
                      <span
                        title={file.contributors
                          .map((c) => `${c.harnessId} · ${c.model}`)
                          .join(", ")}
                        className="rounded bg-[var(--bg-muted)] px-1 py-0.5 text-[var(--text-muted)]"
                      >
                        {t("changesContributorsMore", { count: extraContributors })}
                      </span>
                    )}
                    <span className="text-emerald-600 dark:text-emerald-400">
                      +{file.additions}
                    </span>
                    <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected File Toolbar & Viewer */}
      {selectedPath ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="min-w-0 truncate font-mono text-[11px] font-semibold text-[var(--text-primary)]">
                {selectedPath}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void copyFilePath()}
                  className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {copiedPath ? t("changesCopiedPath") : t("changesCopyPath")}
                </button>
                {canRevert && (
                  <button
                    type="button"
                    disabled={reverting}
                    onClick={() => setConfirmRevertPath(selectedPath)}
                    className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-300"
                  >
                    {reverting ? t("changesReverting") : t("changesRevert")}
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-1.5">
              {mode === "session" && selectedFile && selectedFile.revisions.length > 0 ? (
                <select
                  value={selectedRevId ?? ""}
                  onChange={(e) => onSelectRevId(e.target.value || null)}
                  className="max-w-full min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)] outline-none"
                >
                  <option value="">
                    {t("changesCumulative", { count: selectedFile.revisions.length })}
                  </option>
                  {selectedFile.revisions.map((rev, idx) => (
                    <option key={rev.revId} value={rev.revId}>
                      {t("changesRevisionOption", {
                        seq: rev.seq ?? idx + 1,
                        tool: rev.toolName,
                        harness: rev.harnessId,
                        model: rev.model,
                        add: rev.additions,
                        del: rev.deletions,
                      })}
                    </option>
                  ))}
                </select>
              ) : (
                <span />
              )}

              <Tabs value={viewMode} onValueChange={(v) => onViewModeChange(v as DiffViewMode)}>
                <TabsList className="text-[10px]">
                  <TabsTrigger value="unified" className="px-2 py-0.5 text-[10px]">
                    {t("changesViewUnified")}
                  </TabsTrigger>
                  <TabsTrigger value="split" className="px-2 py-0.5 text-[10px]">
                    {t("changesViewSplit")}
                  </TabsTrigger>
                  <TabsTrigger value="raw" className="px-2 py-0.5 text-[10px]">
                    {t("changesViewRaw")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          <DiffViewer
            filePath={selectedPath}
            viewMode={viewMode}
            diff={diff}
            rawFile={rawFile}
            loading={loadingDetail}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-[var(--text-muted)]">
          {mode === "git" ? t("changesEmptyGit") : t("changesEmptySession")}
        </div>
      )}

      <Dialog
        open={Boolean(confirmRevertPath)}
        onOpenChange={(open) => !open && setConfirmRevertPath(null)}
      >
        <DialogContent className="max-w-sm" closeLabel={t("closeDialog")}>
          <DialogHeader>
            <DialogTitle>{t("changesRevertTitle")}</DialogTitle>
            <DialogDescription>
              {confirmRevertPath
                ? mode === "git"
                  ? t("changesRevertBodyGit", { path: confirmRevertPath })
                  : t("changesRevertBodySession", { path: confirmRevertPath })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmRevertPath(null)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!confirmRevertPath) return;
                const target = confirmRevertPath;
                setConfirmRevertPath(null);
                void onRevert(target);
              }}
            >
              {t("changesConfirmRevert")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
