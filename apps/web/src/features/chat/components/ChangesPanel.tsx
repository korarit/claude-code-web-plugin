import { useState } from "react";
import type {
  FileChangeStatus,
  FileDiffMode,
  FileDiffResponse,
  RawFileResponse,
  SessionChangesSummary,
  SessionFileChange,
} from "@contracts/changes";
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
          <div className="inline-flex rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5 text-[11px]">
            {!lockGitMode && (
              <button
                type="button"
                onClick={() => onModeChange("session")}
                className={`rounded px-2 py-0.5 font-medium transition-colors ${
                  mode === "session"
                    ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t("changesModeSession")}
              </button>
            )}
            <button
              type="button"
              onClick={() => onModeChange("git")}
              className={`rounded px-2 py-0.5 font-medium transition-colors ${
                mode === "git" || lockGitMode
                  ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {t("changesModeGit")}
            </button>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px]">
            {worktreeBranch && (
              <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                {t("worktreeBadge", { branch: worktreeBranch })}
              </span>
            )}
            <span className="text-[var(--text-secondary)]">
              {t("changesSummary", { count: summary.filesCount })}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">+{summary.totalAdditions}</span>
            <span className="text-rose-600 dark:text-rose-400">-{summary.totalDeletions}</span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loadingList}
              className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-sans text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              {t("changesRefresh")}
            </button>
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
          <div className="px-2 py-3 text-center text-xs text-[var(--text-muted)]">...</div>
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

              <div className="inline-flex shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => onViewModeChange("unified")}
                  className={`rounded px-2 py-0.5 font-medium ${
                    viewMode === "unified"
                      ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {t("changesViewUnified")}
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange("split")}
                  className={`rounded px-2 py-0.5 font-medium ${
                    viewMode === "split"
                      ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {t("changesViewSplit")}
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange("raw")}
                  className={`rounded px-2 py-0.5 font-medium ${
                    viewMode === "raw"
                      ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]"
                  }`}
                >
                  {t("changesViewRaw")}
                </button>
              </div>
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

      {confirmRevertPath && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("changesRevertTitle")}
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
              {mode === "git"
                ? t("changesRevertBodyGit", { path: confirmRevertPath })
                : t("changesRevertBodySession", { path: confirmRevertPath })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRevertPath(null)}
                className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)]"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmRevertPath;
                  setConfirmRevertPath(null);
                  void onRevert(target);
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
              >
                {t("changesConfirmRevert")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
