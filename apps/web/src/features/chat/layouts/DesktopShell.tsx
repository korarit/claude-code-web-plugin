import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import SoundToggle from "../components/SoundToggle.tsx";
import ThemeSwitcher from "../components/ThemeSwitcher.tsx";

export type DesktopInspectorTab = "changes" | "agents" | "terminal";

export interface DesktopShellProps {
  activeSession?: SessionInfo;
  usage: UsageState;
  changesCount: number;
  agentsCount: number;
  inspectorOpen: boolean;
  inspectorTab: DesktopInspectorTab;
  onSelectInspectorTab: (tab: DesktopInspectorTab) => void;
  onCloseInspector: () => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
  sidebar: ReactNode;
  chat: ReactNode;
  changes: ReactNode;
  agents: ReactNode;
  terminal: ReactNode;
}

export default function DesktopShell({
  activeSession,
  usage,
  changesCount,
  agentsCount,
  inspectorOpen,
  inspectorTab,
  onSelectInspectorTab,
  onCloseInspector,
  soundMuted,
  onToggleSound,
  onRenameSession,
  sidebar,
  chat,
  changes,
  agents,
  terminal,
}: DesktopShellProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(480);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = window.innerWidth - e.clientX;
      setInspectorWidth(Math.min(760, Math.max(360, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

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

  const toggleTab = (tab: DesktopInspectorTab) => {
    if (inspectorOpen && inspectorTab === tab) {
      onCloseInspector();
    } else {
      onSelectInspectorTab(tab);
    }
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

        <div className="flex shrink-0 items-center gap-2">
          <ContextBar usage={usage} variant="inline" />
          <button
            type="button"
            onClick={() => toggleTab("changes")}
            aria-pressed={inspectorOpen && inspectorTab === "changes"}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              inspectorOpen && inspectorTab === "changes"
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t("changesTab", { count: changesCount })}
          </button>
          <button
            type="button"
            onClick={() => toggleTab("agents")}
            aria-pressed={inspectorOpen && inspectorTab === "agents"}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              inspectorOpen && inspectorTab === "agents"
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t("agentsTab", { count: agentsCount })}
          </button>
          <button
            type="button"
            onClick={() => toggleTab("terminal")}
            aria-pressed={inspectorOpen && inspectorTab === "terminal"}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              inspectorOpen && inspectorTab === "terminal"
                ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                : "border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t("terminalTab")}
          </button>
          <SoundToggle muted={soundMuted} onToggle={onToggleSound} />
          <ThemeSwitcher />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-[260px] shrink-0 border-r border-[var(--border-subtle)]">
          {sidebar}
        </div>
        <div className="flex min-w-0 flex-1">{chat}</div>
        {inspectorOpen && (
          <>
            <div
              onMouseDown={() => {
                draggingRef.current = true;
              }}
              className="w-1 shrink-0 cursor-col-resize bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent-primary)]"
              role="separator"
              aria-orientation="vertical"
            />
            <aside
              style={{ width: `${inspectorWidth}px` }}
              className="flex min-w-0 shrink-0 flex-col bg-[var(--bg-surface)]"
            >
              <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-2 text-xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelectInspectorTab("changes")}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium ${
                      inspectorTab === "changes"
                        ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {t("changesTab", { count: changesCount })}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectInspectorTab("agents")}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium ${
                      inspectorTab === "agents"
                        ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {t("agentsTab", { count: agentsCount })}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectInspectorTab("terminal")}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium ${
                      inspectorTab === "terminal"
                        ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {t("terminalTab")}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={onCloseInspector}
                  aria-label={t("changesCloseInspector")}
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                >
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {inspectorTab === "changes"
                  ? changes
                  : inspectorTab === "agents"
                    ? agents
                    : terminal}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
