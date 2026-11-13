import { useState } from "react";
import type { SessionInfo, SessionOrigin } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { SessionFilters } from "../hooks/useSessions.ts";
import ConfirmDeleteModal from "./ConfirmDeleteModal.tsx";

function folderName(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function StatusIndicator({ status }: { status: SessionInfo["status"] }) {
  if (status === "running") {
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500"
        viewBox="0 0 24 24"
        fill="none"
        aria-label="running"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="opacity-85"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
        />
      </svg>
    );
  }
  if (status === "waiting_permission") {
    return (
      <span
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-amber-500 ring-2 ring-amber-500/30"
        aria-label="waiting permission"
      />
    );
  }
  if (status === "idle") {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
  }
  return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--text-muted)]" />;
}

export interface SessionSidebarProps {
  activeSessions: SessionInfo[];
  archivedSessions: SessionInfo[];
  availableCwds: string[];
  filters: SessionFilters;
  onFiltersChange: (next: SessionFilters) => void;
  selectedSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRename: (sessionId: string, title: string) => Promise<unknown>;
  onArchive: (sessionId: string) => Promise<unknown>;
  onUnarchive: (sessionId: string) => Promise<unknown>;
  onDelete: (sessionId: string) => Promise<unknown>;
}

export default function SessionSidebar({
  activeSessions,
  archivedSessions,
  availableCwds,
  filters,
  onFiltersChange,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
}: SessionSidebarProps) {
  const { t, formatRelativeTime } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionInfo | null>(null);

  const originLabel = (origin: SessionOrigin) => {
    switch (origin) {
      case "web":
        return t("originWeb");
      case "cli":
        return t("originCli");
      case "tmux":
        return t("originTmux");
      case "ide":
        return t("originIde");
      case "opencode_server":
        return t("originOpencode");
    }
  };

  const sessionTitle = (s: SessionInfo) =>
    s.title || s.lastMessagePreview || t("untitledSession");

  const startEditing = (s: SessionInfo) => {
    setEditingId(s.id);
    setEditTitle(s.title ?? s.lastMessagePreview ?? "");
  };

  const commitRename = async (id: string) => {
    await onRename(id, editTitle);
    setEditingId(null);
  };

  const renderRow = (s: SessionInfo, isArchived: boolean) => {
    const selected = s.id === selectedSessionId;
    const isEditing = editingId === s.id;

    return (
      <div
        key={s.id}
        className={`group rounded-md border px-2.5 py-2 transition-colors ${
          selected
            ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
            : "border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]/60"
        }`}
      >
        <div className="flex items-start gap-2">
          <div className="mt-1">
            <StatusIndicator status={s.status} />
          </div>

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void commitRename(s.id);
                }}
                className="flex items-center gap-1"
              >
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="w-full rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-xs text-[var(--text-primary)] outline-none"
                />
                <button
                  type="submit"
                  className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-primary)]"
                >
                  {t("saveName")}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => onSelectSession(s.id)}
                className="w-full text-left"
              >
                <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                  {sessionTitle(s)}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-muted)]">
                  <span className="rounded bg-[var(--bg-muted)] px-1 py-0.5 font-medium text-[var(--text-secondary)]">
                    {originLabel(s.origin)}
                  </span>
                  <span className="rounded bg-[var(--bg-muted)] px-1 py-0.5 font-mono">
                    {s.model}
                  </span>
                  {s.cwd && <span className="truncate">{folderName(s.cwd)}</span>}
                  <span className="ml-auto shrink-0">{formatRelativeTime(s.updatedAt)}</span>
                </div>
                {s.status === "waiting_permission" && (
                  <div className="mt-1 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    {t("statusWaitingPermission")}
                  </div>
                )}
              </button>
            )}
          </div>
        </div>

        {!isEditing && (
          <div className="mt-1.5 flex items-center justify-end gap-1 opacity-100 xl:opacity-0 xl:group-hover:opacity-100">
            <button
              type="button"
              onClick={() => startEditing(s)}
              className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
            >
              {t("rename")}
            </button>
            {isArchived ? (
              <button
                type="button"
                onClick={() => void onUnarchive(s.id)}
                className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
              >
                {t("unarchive")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void onArchive(s.id)}
                className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
              >
                {t("archive")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setPendingDelete(s)}
              className="rounded px-1.5 py-0.5 text-[10px] text-rose-600 hover:bg-rose-500/15 dark:text-rose-400"
            >
              {t("deletePermanently")}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="flex h-full flex-col bg-[var(--bg-surface)]">
      <div className="space-y-2 border-b border-[var(--border-subtle)] p-3">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90"
        >
          <span>+</span>
          <span>{t("newSession")}</span>
        </button>

        <input
          type="search"
          value={filters.q}
          onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })}
          placeholder={t("searchSessionsPlaceholder")}
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)] focus:outline-none"
        />

        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={filters.origin}
            onChange={(e) =>
              onFiltersChange({ ...filters, origin: e.target.value as SessionOrigin | "all" })
            }
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px] text-[var(--text-secondary)] outline-none"
          >
            <option value="all">{t("allSources")}</option>
            <option value="web">{t("originWeb")}</option>
            <option value="cli">{t("originCli")}</option>
            <option value="tmux">{t("originTmux")}</option>
            <option value="ide">{t("originIde")}</option>
          </select>

          <select
            value={filters.cwd}
            onChange={(e) => onFiltersChange({ ...filters, cwd: e.target.value })}
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px] text-[var(--text-secondary)] outline-none"
          >
            <option value="">{t("allProjects")}</option>
            {availableCwds.map((dir) => (
              <option key={dir} value={dir}>
                {folderName(dir)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-2">
        <div>
          <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t("activeSessions")}
          </div>
          {activeSessions.length === 0 ? (
            <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
              {filters.q || filters.origin !== "all" || filters.cwd
                ? t("noSessionsMatch")
                : t("noActiveSessions")}
            </p>
          ) : (
            <div className="space-y-1">
              {activeSessions.map((s) => renderRow(s, false))}
            </div>
          )}
        </div>

        {archivedSessions.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] pt-2">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="flex w-full items-center justify-between px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <span>{t("archivedSessions", { count: archivedSessions.length })}</span>
              <span>{showArchived ? "▾" : "▸"}</span>
            </button>
            {showArchived && (
              <div className="mt-1 space-y-1">
                {archivedSessions.map((s) => renderRow(s, true))}
              </div>
            )}
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDeleteModal
          sessionName={sessionTitle(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const targetId = pendingDelete.id;
            setPendingDelete(null);
            void onDelete(targetId);
          }}
        />
      )}
    </aside>
  );
}
