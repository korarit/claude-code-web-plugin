import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentNode } from "@contracts/agents";
import type { SessionStatus } from "@contracts/chat";
import {
  loadSoundMuted,
  playAttentionSound,
  playCompletedSound,
  playErrorSound,
  saveSoundMuted,
} from "../../../lib/sound.ts";
import { fetchHealth } from "../api.ts";
import { useAgents } from "../hooks/useAgents.ts";
import { useAgentStream } from "../hooks/useAgentStream.ts";
import { useChanges } from "../hooks/useChanges.ts";
import { useChat } from "../hooks/useChat.ts";
import { useHarnesses } from "../hooks/useHarnesses.ts";
import { useSessions } from "../hooks/useSessions.ts";
import { useWorktrees } from "../hooks/useWorktrees.ts";
import AgentBoard from "./AgentBoard.tsx";
import ChangesPanel from "./ChangesPanel.tsx";
import ChatPanel from "./ChatPanel.tsx";
import SessionSidebar from "./SessionSidebar.tsx";
import TerminalPanel from "./TerminalPanel.tsx";
import WorktreeModal from "./WorktreeModal.tsx";
import CompactShell, { type CompactViewTab } from "../layouts/CompactShell.tsx";
import DesktopShell, { type DesktopInspectorTab } from "../layouts/DesktopShell.tsx";

function parseRouteFromPath(pathname: string): { sessionId?: string; agentId?: string } {
  const agentMatch = pathname.match(/^\/sessions\/([^/]+)\/agents\/([^/]+)/);
  if (agentMatch) {
    return {
      sessionId: decodeURIComponent(agentMatch[1]!),
      agentId: decodeURIComponent(agentMatch[2]!),
    };
  }
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)/);
  if (sessionMatch) {
    return { sessionId: decodeURIComponent(sessionMatch[1]!) };
  }
  return {};
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
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);
  const [reviewWorktreeCwd, setReviewWorktreeCwd] = useState<string | undefined>(undefined);
  const [soundMuted, setSoundMuted] = useState<boolean>(() => loadSoundMuted());
  const initialRoute =
    typeof window !== "undefined" ? parseRouteFromPath(window.location.pathname) : {};
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(
    initialRoute.sessionId,
  );
  const [activeAgentId, setActiveAgentId] = useState<string | undefined>(initialRoute.agentId);
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
      const parsed = parseRouteFromPath(window.location.pathname);
      setActiveSessionId(parsed.sessionId);
      setActiveAgentId(parsed.agentId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigateSession = useCallback((sessionId?: string, agentId?: string) => {
    setActiveSessionId(sessionId);
    setActiveAgentId(agentId);
    if (sessionId) setReviewWorktreeCwd(undefined);
    setDrawerOpen(false);
    const nextPath = sessionId
      ? agentId && agentId !== "main"
        ? `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}`
        : `/sessions/${encodeURIComponent(sessionId)}`
      : "/";
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

  const applySessionAgentRef = useRef<((sessionId: string, agent: AgentNode) => void) | undefined>(
    undefined,
  );

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
  } = useSessions({
    onAgentUpdated: (sid, agent) => applySessionAgentRef.current?.(sid, agent),
  });

  const { harnesses } = useHarnesses();
  const agentsState = useAgents(activeSessionId);
  applySessionAgentRef.current = agentsState.applySessionAgentUpdated;
  const changes = useChanges({
    activeSessionId,
    reviewCwd: activeSessionId ? undefined : reviewWorktreeCwd,
    agents: agentsState.agents,
    isDesktop,
  });
  const agentStream = useAgentStream({ activeSessionId, activeAgentId });

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
    harnesses,
    defaultCwd,
    onSessionCreated: (created) => {
      upsertLocal(created);
      navigateSession(created.id);
    },
    onSessionUpdated: (updated) => {
      upsertLocal(updated);
    },
    onFileChanged: changes.applyFileChangedEvent,
    onAgentUpdated: agentsState.applyAgentUpdated,
    onTasksUpdated: agentsState.applyTasksUpdated,
    onErrorNotification: handleErrorNotification,
  });

  const worktreesState = useWorktrees(activeSession?.cwd || chat.cwd || defaultCwd);

  const activeWorktree = useMemo(() => {
    const targetCwd = activeSession?.cwd || chat.cwd;
    if (!targetCwd) return undefined;
    return worktreesState.worktrees.find((w) => w.path === targetCwd);
  }, [activeSession?.cwd, chat.cwd, worktreesState.worktrees]);

  const activeAgentNode = useMemo(() => {
    if (!activeAgentId || activeAgentId === "main") return null;
    return (
      agentsState.agents.find((a) => a.agentId === activeAgentId) ??
      agentStream.agent ?? {
        agentId: activeAgentId,
        role: activeAgentId,
        canSendInput: false,
        state: "thinking" as const,
        updatedAt: new Date().toISOString(),
      }
    );
  }, [activeAgentId, agentStream.agent, agentsState.agents]);

  const isSubagentView = Boolean(activeAgentNode && activeAgentId && activeAgentId !== "main");

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

  const handleInspectAgentChanges = useCallback(
    (agentId: string) => {
      changes.setMode("session");
      changes.setContributorFilter(`agent:${agentId}`);
      if (isDesktop) {
        setInspectorTab("changes");
        setInspectorOpen(true);
      } else {
        setCompactTab("changes");
      }
    },
    [changes, isDesktop],
  );

  const handleInspectAgentStream = useCallback(
    (sessionId: string, agentId: string) => {
      navigateSession(sessionId, agentId);
      if (!isDesktop) {
        setCompactTab("chat");
      }
    },
    [isDesktop, navigateSession],
  );

  const handleReviewWorktreeDiff = useCallback(
    (wtPath: string) => {
      const matchingSession = sessions.find((s) => s.cwd === wtPath);
      if (matchingSession) {
        setReviewWorktreeCwd(undefined);
        navigateSession(matchingSession.id);
      } else {
        setReviewWorktreeCwd(wtPath);
        chat.setCwd(wtPath);
        navigateSession(undefined);
      }
      changes.setMode("git");
      if (isDesktop) {
        setInspectorTab("changes");
        setInspectorOpen(true);
      } else {
        setCompactTab("changes");
      }
    },
    [changes, chat, isDesktop, navigateSession, sessions],
  );

  const sidebarNode = (
    <SessionSidebar
      activeSessions={activeSessions}
      archivedSessions={archivedSessions}
      availableCwds={availableCwds}
      filters={filters}
      onFiltersChange={setFilters}
      selectedSessionId={activeSessionId}
      selectedAgentId={activeAgentId}
      selectedSessionAgents={agentsState.agents}
      agentsBySession={agentsState.agentsBySession}
      worktrees={worktreesState.worktrees}
      onSelectSession={(id) => navigateSession(id)}
      onSelectAgent={handleInspectAgentStream}
      onNewSession={() => {
        setReviewWorktreeCwd(undefined);
        navigateSession(undefined);
      }}
      onRename={rename}
      onArchive={archive}
      onUnarchive={unarchive}
      onDelete={handleDelete}
    />
  );

  const chatNode = (
    <ChatPanel
      activeSession={activeSession}
      harnesses={harnesses}
      harnessId={chat.harnessId}
      onHarnessChange={chat.setHarnessId}
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
      messages={isSubagentView ? agentStream.messages : chat.messages}
      tasks={isSubagentView ? agentStream.tasks : chat.tasks}
      usage={
        isSubagentView && agentStream.usage.inputTokens > 0
          ? agentStream.usage
          : chat.usage
      }
      status={chat.status}
      permissionPrompt={isSubagentView ? null : chat.permissionPrompt}
      pendingInteraction={isSubagentView ? null : chat.pendingInteraction}
      concurrencyWarning={isSubagentView ? null : chat.concurrencyWarning}
      submittingInteraction={chat.submittingInteraction}
      resuming={chat.resuming}
      switchingHarness={chat.switchingHarness}
      uploadingImage={chat.uploadingImage}
      sending={chat.sending}
      error={isSubagentView ? (agentStream.error ?? chat.error) : chat.error}
      onSend={() => void chat.send()}
      onAbort={() => void chat.abort()}
      onSubmitDecision={(d) => void chat.submitDecision(d)}
      onSubmitQuestion={(a) => void chat.submitQuestion(a)}
      onContinueInWeb={() => void chat.continueInWeb()}
      onSwitchHarness={(nextHarnessId) => void chat.switchHarness(nextHarnessId)}
      onUploadImage={(file) => void chat.uploadImage(file)}
      onOpenTerminal={handleOpenTerminal}
      changesFiles={changes.files}
      onInspectFileChange={handleInspectFileChange}
      showInlineContextBar={!isDesktop}
      activeAgent={activeAgentNode}
      onBackToMain={() => navigateSession(activeSessionId)}
      activeWorktree={activeWorktree}
      onOpenWorktreeModal={() => {
        void worktreesState.refresh(activeSession?.cwd || chat.cwd || defaultCwd);
        setWorktreeModalOpen(true);
      }}
    />
  );

  const changesNode = (
    <ChangesPanel
      hasSession={Boolean(activeSessionId || reviewWorktreeCwd)}
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
      worktreeBranch={
        activeWorktree && !activeWorktree.isMain && activeWorktree.branch
          ? activeWorktree.branch
          : undefined
      }
      canRevert={Boolean(activeSessionId)}
      lockGitMode={!activeSessionId && Boolean(reviewWorktreeCwd)}
    />
  );

  const agentsNode = (
    <AgentBoard
      hasSession={Boolean(activeSessionId)}
      agents={agentsState.agents}
      tasks={agentsState.tasks}
      activeAgentId={activeAgentId}
      loading={agentsState.loading}
      onInspectAgent={(agentId) => {
        if (activeSessionId) handleInspectAgentStream(activeSessionId, agentId);
      }}
      onBackToMain={() => navigateSession(activeSessionId)}
      onInspectAgentChanges={handleInspectAgentChanges}
    />
  );

  const terminalNode = (
    <TerminalPanel
      activeSession={activeSession}
      onContinueInWeb={() => void chat.continueInWeb()}
      resuming={chat.resuming}
    />
  );

  const resetRemovedWorktreeCwd = useCallback(
    (removedPath: string) => {
      const fallback = worktreesState.repoRoot ?? defaultCwd ?? "";
      if (chat.cwd === removedPath) {
        chat.setCwd(fallback);
      }
      if (reviewWorktreeCwd === removedPath) {
        setReviewWorktreeCwd(undefined);
      }
    },
    [chat, defaultCwd, reviewWorktreeCwd, worktreesState.repoRoot],
  );

  const worktreeModal = (
    <WorktreeModal
      open={worktreeModalOpen}
      repoRoot={worktreesState.repoRoot}
      worktrees={worktreesState.worktrees}
      selectedCwd={activeSession?.cwd || chat.cwd}
      busy={worktreesState.busy}
      error={worktreesState.error}
      onClose={() => setWorktreeModalOpen(false)}
      onCreate={(branch, baseBranch) => worktreesState.create({ branch, baseBranch })}
      onSelectWorktree={(wtPath) => {
        setReviewWorktreeCwd(undefined);
        chat.setCwd(wtPath);
        if (activeSessionId) navigateSession(undefined);
      }}
      onReviewDiff={handleReviewWorktreeDiff}
      onMerge={async (worktreePath, removeAfterMerge) => {
        const res = await worktreesState.merge({ worktreePath, removeAfterMerge });
        if (res.worktreeRemoved) resetRemovedWorktreeCwd(worktreePath);
        return res;
      }}
      onRemove={async (worktreePath) => {
        const res = await worktreesState.remove({ worktreePath });
        resetRemovedWorktreeCwd(worktreePath);
        return res;
      }}
    />
  );

  if (isDesktop) {
    return (
      <>
        <DesktopShell
          activeSession={activeSession}
          usage={isSubagentView && agentStream.usage.inputTokens > 0 ? agentStream.usage : chat.usage}
          changesCount={changes.summary.filesCount}
          agentsCount={agentsState.agents.length}
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
          agents={agentsNode}
          terminal={terminalNode}
        />
        {worktreeModal}
      </>
    );
  }

  return (
    <>
      <CompactShell
        activeSession={activeSession}
        usage={isSubagentView && agentStream.usage.inputTokens > 0 ? agentStream.usage : chat.usage}
        changesCount={changes.summary.filesCount}
        agentsCount={agentsState.agents.length}
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
        agents={agentsNode}
        terminal={terminalNode}
      />
      {worktreeModal}
    </>
  );
}
