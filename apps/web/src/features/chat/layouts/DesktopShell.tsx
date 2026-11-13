import { useState, type ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import ThemeSwitcher from "../components/ThemeSwitcher.tsx";

export interface DesktopShellProps {
  activeSession?: SessionInfo;
  usage: UsageState;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
  sidebar: ReactNode;
  chat: ReactNode;
}

export default function DesktopShell({
  activeSession,
  usage,
  onRenameSession,
  sidebar,
  chat,
}: DesktopShellProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const displayTitle =
    activeSession?.title || activeSession?.lastMessagePreview || t("untitledSession");

  const startRename = () => {
    if (!activeSession || !onRenameSession) return;
    setDraftTitle(activeSession.title ?? activeSession.lastMessagePreview ?? "");
    setEditing(true);
  };

  const commitRename = async () => {
    if (!activeSession || !onRenameSession) return;
    await onRenameSession(activeSession.id, draftTitle);
    setEditing(false);
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-sm font-bold tracking-tight">{t("appName")}</span>
          {activeSession && (
            <>
              <span className="text-[var(--text-muted)]">/</span>
              {editing ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commitRename();
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditing(false);
                    }}
                    className="w-56 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none"
                  />
                  <button
                    type="submit"
                    className="rounded bg-[var(--bg-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-primary)]"
                  >
                    {t("saveName")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    {t("cancel")}
                  </button>
                </form>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-[var(--text-secondary)]">
                    {displayTitle}
                  </span>
                  {onRenameSession && (
                    <button
                      type="button"
                      onClick={startRename}
                      className="rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    >
                      {t("rename")}
                    </button>
                  )}
                </div>
              )}
              <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                {activeSession.harnessId} · {activeSession.model}
              </span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <ContextBar usage={usage} variant="inline" />
          <ThemeSwitcher />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-[260px] shrink-0 border-r border-[var(--border-subtle)]">
          {sidebar}
        </div>
        <div className="flex min-w-0 flex-1">{chat}</div>
      </div>
    </div>
  );
}
