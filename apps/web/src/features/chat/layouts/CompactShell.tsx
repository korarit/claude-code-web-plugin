import type { ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import ThemeSwitcher from "../components/ThemeSwitcher.tsx";

export interface CompactShellProps {
  activeSession?: SessionInfo;
  usage: UsageState;
  hasBackgroundActivity: boolean;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  onNewSession: () => void;
  sidebar: ReactNode;
  chat: ReactNode;
}

export default function CompactShell({
  activeSession,
  usage,
  hasBackgroundActivity,
  drawerOpen,
  onDrawerOpenChange,
  onNewSession,
  sidebar,
  chat,
}: CompactShellProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onDrawerOpenChange(true)}
            aria-label={t("openSidebar")}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)]"
          >
            <span>☰</span>
            {hasBackgroundActivity && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500 ring-2 ring-[var(--bg-surface)]" />
            )}
          </button>

          <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
            {activeSession?.title ||
              activeSession?.lastMessagePreview ||
              t("appName")}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onNewSession}
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)]"
          >
            +
          </button>
          <ThemeSwitcher />
        </div>
      </header>

      <ContextBar usage={usage} variant="strip" />

      <div className="flex min-h-0 flex-1">{chat}</div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div className="h-full w-[85vw] max-w-[320px] border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
              <span className="text-xs font-semibold">{t("sessions")}</span>
              <button
                type="button"
                onClick={() => onDrawerOpenChange(false)}
                aria-label={t("closeSidebar")}
                className="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
              >
                ✕
              </button>
            </div>
            <div className="h-[calc(100%-37px)]">{sidebar}</div>
          </div>
          <div
            className="flex-1 bg-black/45"
            onClick={() => onDrawerOpenChange(false)}
          />
        </div>
      )}
    </div>
  );
}
