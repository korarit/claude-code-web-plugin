import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionStatus } from "@contracts/chat";
import {
  loadSoundMuted,
  playAttentionSound,
  playCompletedSound,
  playErrorSound,
  saveSoundMuted,
} from "../../../lib/sound.ts";
import { fetchHealth } from "../api.ts";
import { useChanges } from "../hooks/useChanges.ts";
import { useChat } from "../hooks/useChat.ts";
import { useSessions } from "../hooks/useSessions.ts";
import ChangesPanel from "./ChangesPanel.tsx";
import ChatPanel from "./ChatPanel.tsx";
import SessionSidebar from "./SessionSidebar.tsx";
import TerminalPanel from "./TerminalPanel.tsx";
import CompactShell, { type CompactViewTab } from "../layouts/CompactShell.tsx";
import DesktopShell, { type DesktopInspectorTab } from "../layouts/DesktopShell.tsx";

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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<DesktopInspectorTab>("changes");
  const [compactTab, setCompactTab] = useState<CompactViewTab>("chat");
  const [soundMuted, setSoundMuted] = useState<boolean>(() => loadSoundMuted());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() =>
    typeof window !== "undefined" ? parseSessionIdFromPath(window.location.pathname) : undefined,
  );
  const [tmuxAvailable, setTmuxAvailable] = useState(true);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setTmuxAvailable(h.tmuxAvailable);
        setApiKeyConfigured(Boolean(h.apiKeyConfigured));
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

  const toggleSound = useCallback(() => {
    setSoundMuted((prev) => {
      const next = !prev;
      saveSoundMuted(next);
      return next;
    });
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

  const changes = useChanges({ activeSessionId, isDesktop });

  // Play sound notifications when sessions transition into waiting_permission or finish in background.
  const prevStatusMapRef = useRef<Map<string, SessionStatus>>(new Map());
  useEffect(() => {
    const prevMap = prevStatusMapRef.current;
    const nextMap = new Map<string, SessionStatus>();
    let playAttention = false;
    let playCompleted = false;

    for (const s of sessions) {
      nextMap.set(s.id, s.status);
      const prevStatus = prevMap.get(s.id);
      if (!prevStatus || prevStatus === s.status) continue;

      if (s.status === "waiting_permission") {
        playAttention = true;
      } else if (
        prevStatus === "running" &&
        s.status === "idle"
      ) {
        if (s.id === activeSessionId && changes.mode === "git") {
          void changes.refreshList(s.id, "git");
        }
        if (s.id !== activeSessionId || document.hidden) {
          playCompleted = true;
        }
      }
    }

    prevStatusMapRef.current = nextMap;
    if (playAttention) {
      playAttentionSound(soundMuted);
    } else if (playCompleted) {
      playCompletedSound(soundMuted);
    }
  }, [sessions, activeSessionId, soundMuted, changes]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );

  const recentCwds = useMemo(() => {
    const set = new Set<string>(availableCwds);
    if (defaultCwd) set.add(defaultCwd);
    return [...set];
  }, [availableCwds, defaultCwd]);

  const handleErrorNotification = useCallback(() => {
    playErrorSound(soundMuted);
  }, [soundMuted]);

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
    onFileChanged: changes.applyFileChangedEvent,
    onErrorNotification: handleErrorNotification,
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

  const handleOpenTerminal = useCallback(() => {
    if (isDesktop) {
      setInspectorTab("terminal");
      setInspectorOpen(true);
    } else {
      setCompactTab("terminal");
    }
  }, [isDesktop]);

  const handleInspectFileChange = useCallback(
    (path: string, revId?: string) => {
      changes.openFileChange(path, revId);
      if (isDesktop) {
        setInspectorTab("changes");
        setInspectorOpen(true);
      } else {
        setCompactTab("changes");
      }
    },
    [changes, isDesktop],
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
      apiKeyConfigured={apiKeyConfigured}
      recentCwds={recentCwds}
      model={chat.model}
      onModelChange={(m) => void chat.setModel(m)}
      cwd={chat.cwd}
      onCwdChange={chat.setCwd}
      authMode={chat.authMode}
      onAuthModeChange={chat.setAuthMode}
      agentProfile={chat.agentProfile}
      onAgentProfileChange={chat.setAgentProfile}
      draft={chat.draft}
      onDraftChange={chat.setDraft}
      messages={chat.messages}
      tasks={chat.tasks}
      usage={chat.usage}
      status={chat.status}
      permissionPrompt={chat.permissionPrompt}
      pendingInteraction={chat.pendingInteraction}
      concurrencyWarning={chat.concurrencyWarning}
      submittingInteraction={chat.submittingInteraction}
      resuming={chat.resuming}
      uploadingImage={chat.uploadingImage}
      sending={chat.sending}
      error={chat.error}
      onSend={() => void chat.send()}
      onAbort={() => void chat.abort()}
      onSubmitDecision={(d) => void chat.submitDecision(d)}
      onSubmitQuestion={(a) => void chat.submitQuestion(a)}
      onContinueInWeb={() => void chat.continueInWeb()}
      onUploadImage={(file) => void chat.uploadImage(file)}
      onOpenTerminal={handleOpenTerminal}
      changesFiles={changes.files}
      onInspectFileChange={handleInspectFileChange}
      showInlineContextBar={!isDesktop}
    />
  );

  const changesNode = (
    <ChangesPanel
      hasSession={Boolean(activeSessionId)}
      mode={changes.mode}
      onModeChange={changes.setMode}
      files={changes.filteredFiles}
      summary={changes.summary}
      selectedPath={changes.selectedPath}
      onSelectPath={changes.setSelectedPath}
      selectedRevId={changes.selectedRevId}
      onSelectRevId={changes.setSelectedRevId}
      selectedFile={changes.selectedFile}
      viewMode={changes.viewMode}
      onViewModeChange={changes.setViewMode}
      contributorFilter={changes.contributorFilter}
      onContributorFilterChange={changes.setContributorFilter}
      contributorOptions={changes.contributorOptions}
      diff={changes.diff}
      rawFile={changes.rawFile}
      loadingList={changes.loadingList}
      loadingDetail={changes.loadingDetail}
      reverting={changes.reverting}
      error={changes.error}
      onRefresh={() => void changes.refreshList()}
      onRevert={changes.revert}
    />
  );

  const terminalNode = (
    <TerminalPanel
      activeSession={activeSession}
      onContinueInWeb={() => void chat.continueInWeb()}
      resuming={chat.resuming}
    />
  );

  if (isDesktop) {
    return (
      <DesktopShell
        activeSession={activeSession}
        usage={chat.usage}
        changesCount={changes.summary.filesCount}
        inspectorOpen={inspectorOpen}
        inspectorTab={inspectorTab}
        onSelectInspectorTab={(tab) => {
          setInspectorTab(tab);
          setInspectorOpen(true);
        }}
        onCloseInspector={() => setInspectorOpen(false)}
        soundMuted={soundMuted}
        onToggleSound={toggleSound}
        onRenameSession={rename}
        sidebar={sidebarNode}
        chat={chatNode}
        changes={changesNode}
        terminal={terminalNode}
      />
    );
  }

  return (
    <CompactShell
      activeSession={activeSession}
      usage={chat.usage}
      changesCount={changes.summary.filesCount}
      hasBackgroundActivity={hasBackgroundActivity(activeSessionId)}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={setDrawerOpen}
      activeTab={compactTab}
      onTabChange={setCompactTab}
      soundMuted={soundMuted}
      onToggleSound={toggleSound}
      onNewSession={() => navigateSession(undefined)}
      sidebar={sidebarNode}
      chat={chatNode}
      changes={changesNode}
      terminal={terminalNode}
    />
  );
}
