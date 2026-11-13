import { useState, type ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import HarnessBadge from "../components/HarnessBadge.tsx";
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
  onOpenCommandPalette: () => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
  sidebar: ReactNode;
  chat: ReactNode;
  changes: ReactNode;
  agents: ReactNode;
  terminal: ReactNode;
}

/** Desktop (>= 1280px) 3-column workspace with resizable split panels. */
export default function DesktopShell({
  activeSession,
  usage,
  changesCount,
  agentsCount,
  inspectorOpen,
  inspectorTab,
  onSelectInspectorTab,
  onCloseInspector,
  onOpenCommandPalette,
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
                  <Button type="submit" size="xs" variant="secondary">
                    {t("saveName")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    {t("cancel")}
                  </Button>
                </form>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-[var(--text-secondary)]">
                    {displayTitle}
                  </span>
                  {onRenameSession && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={startRename}
                      className="h-5 px-1.5 text-[10px] text-[var(--text-muted)]"
                    >
                      {t("rename")}
                    </Button>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                <HarnessBadge harnessId={activeSession.harnessId} compact />
                <Badge variant="secondary" className="font-mono">
                  {activeSession.model}
                </Badge>
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <ContextBar usage={usage} variant="inline" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenCommandPalette}
            aria-label={t("commandPaletteAriaLabel")}
            className="gap-1.5"
          >
            <Search className="h-3 w-3" />
            <span>{t("commandPaletteButton")}</span>
            <kbd className="rounded bg-[var(--bg-elevated)] px-1 font-mono text-[10px] text-[var(--text-muted)]">
              {t("commandPaletteShortcut")}
            </kbd>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inspectorOpen && inspectorTab === "changes" ? "secondary" : "outline"}
            onClick={() => toggleTab("changes")}
            aria-pressed={inspectorOpen && inspectorTab === "changes"}
          >
            {t("changesTab", { count: changesCount })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inspectorOpen && inspectorTab === "agents" ? "secondary" : "outline"}
            onClick={() => toggleTab("agents")}
            aria-pressed={inspectorOpen && inspectorTab === "agents"}
          >
            {t("agentsTab", { count: agentsCount })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inspectorOpen && inspectorTab === "terminal" ? "secondary" : "outline"}
            onClick={() => toggleTab("terminal")}
            aria-pressed={inspectorOpen && inspectorTab === "terminal"}
          >
            {t("terminalTab")}
          </Button>
          <SoundToggle muted={soundMuted} onToggle={onToggleSound} />
          <ThemeSwitcher />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" id="hw-desktop-layout">
          <ResizablePanel
            id="sidebar"
            defaultSize={260}
            minSize={200}
            maxSize={380}
            className="flex flex-col"
          >
            {sidebar}
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="chat" minSize="30%" className="flex min-w-0">
            {chat}
          </ResizablePanel>

          {inspectorOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="inspector"
                defaultSize={460}
                minSize={320}
                maxSize={720}
                className="flex min-w-0 flex-col bg-[var(--bg-surface)]"
              >
                <Tabs
                  value={inspectorTab}
                  onValueChange={(v) => onSelectInspectorTab(v as DesktopInspectorTab)}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-2 text-xs">
                    <TabsList>
                      <TabsTrigger value="changes">
                        {t("changesTab", { count: changesCount })}
                      </TabsTrigger>
                      <TabsTrigger value="agents">
                        {t("agentsTab", { count: agentsCount })}
                      </TabsTrigger>
                      <TabsTrigger value="terminal">{t("terminalTab")}</TabsTrigger>
                    </TabsList>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={onCloseInspector}
                      aria-label={t("changesCloseInspector")}
                      className="h-6 w-6 p-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <TabsContent value="changes">{changes}</TabsContent>
                  <TabsContent value="agents">{agents}</TabsContent>
                  <TabsContent value="terminal">{terminal}</TabsContent>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
