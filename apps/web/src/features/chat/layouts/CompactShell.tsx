import type { ReactNode } from "react";
import type { SessionInfo } from "@contracts/chat";
import { Menu, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";
import ContextBar from "../components/ContextBar.tsx";
import HarnessBadge from "../components/HarnessBadge.tsx";
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
  onOpenCommandPalette: () => void;
  soundMuted: boolean;
  onToggleSound: () => void;
  onNewSession: () => void;
  sidebar: ReactNode;
  chat: ReactNode;
  changes: ReactNode;
  agents: ReactNode;
  terminal: ReactNode;
}

/** Compact (< 1280px) single-focus layout with Sheet drawer and bottom tab bar. */
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
  onOpenCommandPalette,
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
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => onDrawerOpenChange(true)}
            aria-label={t("openSidebar")}
            className="relative shrink-0"
          >
            <Menu className="h-4 w-4" />
            {hasBackgroundActivity && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500 ring-2 ring-[var(--bg-surface)]" />
            )}
          </Button>

          <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
            {activeSession?.title || activeSession?.lastMessagePreview || t("appName")}
          </span>
          {activeSession && (
            <span className="hidden shrink-0 sm:inline-flex">
              <HarnessBadge harnessId={activeSession.harnessId} compact />
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={onOpenCommandPalette}
            aria-label={t("commandPaletteAriaLabel")}
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={onNewSession}
            aria-label={t("newSession")}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <SoundToggle muted={soundMuted} onToggle={onToggleSound} />
          <ThemeSwitcher />
        </div>
      </header>

      <ContextBar usage={usage} variant="strip" />

      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as CompactViewTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <TabsContent value="chat">{chat}</TabsContent>
          <TabsContent value="changes">{changes}</TabsContent>
          <TabsContent value="agents">{agents}</TabsContent>
          <TabsContent value="terminal">{terminal}</TabsContent>
        </div>

        <nav className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          <TabsList className="grid w-full grid-cols-4 border-0 bg-transparent p-0">
            <TabsTrigger value="chat" className="py-2 text-xs font-semibold">
              {t("chatTab")}
            </TabsTrigger>
            <TabsTrigger value="changes" className="py-2 text-xs font-semibold">
              {t("changesTab", { count: changesCount })}
            </TabsTrigger>
            <TabsTrigger value="agents" className="py-2 text-xs font-semibold">
              {t("agentsTab", { count: agentsCount })}
            </TabsTrigger>
            <TabsTrigger value="terminal" className="py-2 text-xs font-semibold">
              {t("terminalTab")}
            </TabsTrigger>
          </TabsList>
        </nav>
      </Tabs>

      <Sheet open={drawerOpen} onOpenChange={onDrawerOpenChange}>
        <SheetContent side="left" className="p-0" closeLabel={t("closeSidebar")}>
          <SheetHeader>
            <SheetTitle>{t("sessions")}</SheetTitle>
            <SheetDescription>{t("activeSessions")}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
