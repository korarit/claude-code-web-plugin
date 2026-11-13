import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHealth } from "../api.ts";
import { useChat } from "../hooks/useChat.ts";
import { useSessions } from "../hooks/useSessions.ts";
import ChatPanel from "./ChatPanel.tsx";
import SessionSidebar from "./SessionSidebar.tsx";
import CompactShell from "../layouts/CompactShell.tsx";
import DesktopShell from "../layouts/DesktopShell.tsx";

function parseSessionIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/sessions\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(min-width: 1280px)").matches
      : true,
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}

export default function WorkspacePage() {
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() =>
    typeof window !== "undefined" ? parseSessionIdFromPath(window.location.pathname) : undefined,
  );
  const [tmuxAvailable, setTmuxAvailable] = useState(true);
  const [defaultCwd, setDefaultCwd] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setTmuxAvailable(h.tmuxAvailable);
        if (h.defaultCwd) setDefaultCwd(h.defaultCwd);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setActiveSessionId(parseSessionIdFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigateSession = useCallback((sessionId?: string) => {
    setActiveSessionId(sessionId);
    setDrawerOpen(false);
    const nextPath = sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : "/";
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
  }, []);

  const {
    sessions,
    activeSessions,
    archivedSessions,
    availableCwds,
    filters,
    setFilters,
    upsertLocal,
    rename,
    archive,
    unarchive,
    remove,
    hasBackgroundActivity,
  } = useSessions();

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );

  const chat = useChat({
    activeSessionId,
    activeSession,
    defaultCwd,
    onSessionCreated: (created) => {
      upsertLocal(created);
      navigateSession(created.id);
    },
    onSessionUpdated: (updated) => {
      upsertLocal(updated);
    },
  });

  const handleDelete = useCallback(
    async (sessionId: string) => {
      await remove(sessionId);
      if (activeSessionId === sessionId) {
        navigateSession(undefined);
      }
    },
    [activeSessionId, navigateSession, remove],
  );

  const sidebarNode = (
    <SessionSidebar
      activeSessions={activeSessions}
      archivedSessions={archivedSessions}
      availableCwds={availableCwds}
      filters={filters}
      onFiltersChange={setFilters}
      selectedSessionId={activeSessionId}
      onSelectSession={(id) => navigateSession(id)}
      onNewSession={() => navigateSession(undefined)}
      onRename={rename}
      onArchive={archive}
      onUnarchive={unarchive}
      onDelete={handleDelete}
    />
  );

  const chatNode = (
    <ChatPanel
      activeSession={activeSession}
      tmuxAvailable={tmuxAvailable}
      model={chat.model}
      onModelChange={chat.setModel}
      cwd={chat.cwd}
      onCwdChange={chat.setCwd}
      draft={chat.draft}
      onDraftChange={chat.setDraft}
      messages={chat.messages}
      tasks={chat.tasks}
      usage={chat.usage}
      status={chat.status}
      permissionPrompt={chat.permissionPrompt}
      sending={chat.sending}
      error={chat.error}
      onSend={() => void chat.send()}
      onAbort={() => void chat.abort()}
      showInlineContextBar={!isDesktop}
    />
  );

  if (isDesktop) {
    return (
      <DesktopShell
        activeSession={activeSession}
        usage={chat.usage}
        onRenameSession={rename}
        sidebar={sidebarNode}
        chat={chatNode}
      />
    );
  }

  return (
    <CompactShell
      activeSession={activeSession}
      usage={chat.usage}
      hasBackgroundActivity={hasBackgroundActivity(activeSessionId)}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={setDrawerOpen}
      onNewSession={() => navigateSession(undefined)}
      sidebar={sidebarNode}
      chat={chatNode}
    />
  );
}
