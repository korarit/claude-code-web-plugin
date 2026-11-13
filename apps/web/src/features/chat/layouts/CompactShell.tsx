import type { ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import SoundToggle from "../components/SoundToggle.tsx";
import ThemeSwitcher from "../components/ThemeSwitcher.tsx";

export type CompactViewTab = "chat" | "changes" | "agents" | "terminal";

export interface CompactShellProps {
  activeSession?: SessionInfo;
  usage: UsageState;
  changesCount: number;
  agentsCount: number;
  hasBackgroundActivity: boolean;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
  activeTab: CompactViewTab;
  onTabChange: (tab: CompactViewTab) => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  onNewSession: () => void;
  sidebar: ReactNode;
  chat: ReactNode;
  changes: ReactNode;
  agents: ReactNode;
  terminal: ReactNode;
}

export default function CompactShell({
  activeSession,
  usage,
  changesCount,
  agentsCount,
  hasBackgroundActivity,
  drawerOpen,
  onDrawerOpenChange,
  activeTab,
  onTabChange,
  soundMuted,
  onToggleSound,
  onNewSession,
  sidebar,
  chat,
  changes,
  agents,
  terminal,
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
            {activeSession?.title || activeSession?.lastMessagePreview || t("appName")}
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
          <SoundToggle muted={soundMuted} onToggle={onToggleSound} />
          <ThemeSwitcher />
        </div>
      </header>

      <ContextBar usage={usage} variant="strip" />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {activeTab === "chat" ? (
          chat
        ) : activeTab === "changes" ? (
          <div className="min-w-0 flex-1 overflow-hidden">{changes}</div>
        ) : activeTab === "agents" ? (
          <div className="min-w-0 flex-1 overflow-hidden">{agents}</div>
        ) : (
          <div className="min-w-0 flex-1 overflow-hidden">{terminal}</div>
        )}
      </div>

      <nav className="flex h-12 shrink-0 items-center border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          onClick={() => onTabChange("chat")}
          className={`flex-1 py-2 text-xs font-semibold ${
            activeTab === "chat"
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          {t("chatTab")}
        </button>
        <button
          type="button"
          onClick={() => onTabChange("changes")}
          className={`flex-1 py-2 text-xs font-semibold ${
            activeTab === "changes"
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          {t("changesTab", { count: changesCount })}
        </button>
        <button
          type="button"
          onClick={() => onTabChange("agents")}
          className={`flex-1 py-2 text-xs font-semibold ${
            activeTab === "agents"
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          {t("agentsTab", { count: agentsCount })}
        </button>
        <button
          type="button"
          onClick={() => onTabChange("terminal")}
          className={`flex-1 py-2 text-xs font-semibold ${
            activeTab === "terminal"
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }`}
        >
          {t("terminalTab")}
        </button>
      </nav>

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
