import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { AgentNode } from "@contracts/agents";
import type { SessionFileChange } from "@contracts/changes";
import type { HarnessDescriptor, HarnessId } from "@contracts/harness";
import type { GitWorktreeInfo } from "@contracts/workspace";
import {
  AVAILABLE_MODELS,
  type AuthMode,
  type ConcurrencyWarning,
  type ModelId,
  type PendingInteraction,
  type PermissionDecision,
  type PermissionPromptPayload,
  type SessionInfo,
  type SessionStatus,
  type WorkspaceFileEntry,
} from "@contracts/chat";
import { Badge } from "@/components/ui/badge.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { getAgentStateMeta } from "../agentStateMeta.ts";
import { fetchWorkspaceFiles } from "../api.ts";
import type { ChatMessage, TaskEntry, UsageState } from "../hooks/useChat.ts";
import ContextBar from "./ContextBar.tsx";
import HarnessBadge, { getHarnessLabelKey } from "./HarnessBadge.tsx";
import HarnessPicker from "./HarnessPicker.tsx";
import InteractionCard from "./InteractionCard.tsx";
import MarkdownContent from "./MarkdownContent.tsx";
import TaskTimeline from "./TaskTimeline.tsx";
import ToolCallBlock from "./ToolCallBlock.tsx";

const BASE_SLASH_COMMANDS = ["/compact", "/clear", "/cost"] as const;

export interface ChatPanelProps {
  activeSession?: SessionInfo;
  harnesses?: HarnessDescriptor[];
  harnessId?: HarnessId;
  onHarnessChange?: (harnessId: HarnessId) => void;
  tmuxAvailable: boolean;
  apiKeyConfigured: boolean;
  recentCwds: string[];
  model: ModelId;
  onModelChange: (model: ModelId) => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
  authMode: AuthMode;
  onAuthModeChange: (authMode: AuthMode) => void;
  agentProfile: string;
  onAgentProfileChange: (agentProfile: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  messages: ChatMessage[];
  tasks: TaskEntry[];
  usage: UsageState;
  status: SessionStatus;
  permissionPrompt: PermissionPromptPayload | null;
  pendingInteraction: PendingInteraction | null;
  concurrencyWarning: ConcurrencyWarning | null;
  submittingInteraction: boolean;
  resuming: boolean;
  switchingHarness?: boolean;
  uploadingImage: boolean;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onAbort: () => void;
  onSubmitDecision: (decision: PermissionDecision) => void;
  onSubmitQuestion: (answers: Record<string, string | string[]>) => void;
  onContinueInWeb: () => void;
  onSwitchHarness?: (harnessId: HarnessId) => void;
  onUploadImage: (file: File) => void;
  onOpenTerminal?: () => void;
  changesFiles?: SessionFileChange[];
  onInspectFileChange?: (path: string, revId?: string) => void;
  showInlineContextBar?: boolean;
  activeAgent?: AgentNode | null;
  onBackToMain?: () => void;
  activeWorktree?: GitWorktreeInfo;
  onOpenWorktreeModal?: () => void;
}

export default function ChatPanel({
  activeSession,
  harnesses = [],
  harnessId = "claude",
  onHarnessChange,
  tmuxAvailable,
  apiKeyConfigured,
  recentCwds,
  model,
  onModelChange,
  cwd,
  onCwdChange,
  authMode,
  onAuthModeChange,
  agentProfile,
  onAgentProfileChange,
  draft,
  onDraftChange,
  messages,
  tasks,
  usage,
  status,
  permissionPrompt,
  pendingInteraction,
  concurrencyWarning,
  submittingInteraction,
  resuming,
  switchingHarness = false,
  uploadingImage,
  sending,
  error,
  onSend,
  onAbort,
  onSubmitDecision,
  onSubmitQuestion,
  onContinueInWeb,
  onSwitchHarness,
  onUploadImage,
  onOpenTerminal,
  changesFiles,
  onInspectFileChange,
  showInlineContextBar = false,
  activeAgent,
  onBackToMain,
  activeWorktree,
  onOpenWorktreeModal,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [slashOpen, setSlashOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionFiles, setMentionFiles] = useState<WorkspaceFileEntry[]>([]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, status, pendingInteraction?.id]);

  // Detect @file mention token near end of draft.
  useEffect(() => {
    const match = draft.match(/(?:^|\s)@([^\s]*)$/);
    if (match) {
      setMentionQuery(match[1] ?? "");
    } else {
      setMentionQuery(null);
    }

    if (draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")) {
      setSlashOpen(true);
    } else if (!draft.startsWith("/")) {
      setSlashOpen(false);
    }
  }, [draft]);

  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    let cancelled = false;
    const targetCwd = activeSession?.cwd || cwd.trim() || undefined;
    const timer = setTimeout(() => {
      fetchWorkspaceFiles(targetCwd, mentionQuery)
        .then((files) => {
          if (!cancelled) setMentionFiles(files.slice(0, 10));
        })
        .catch(() => {
          if (!cancelled) setMentionFiles([]);
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, activeSession?.cwd, cwd]);

  const isBusy = status === "running" || status === "waiting_permission";
  const isMirror = activeSession?.controlMode === "mirror";
  const isSubagentView = Boolean(activeAgent && activeAgent.agentId !== "main");
  const isReadOnlySubagent = Boolean(isSubagentView && activeAgent && !activeAgent.canSendInput);

  const insertSlashCommand = (cmd: string) => {
    onDraftChange(cmd);
    setSlashOpen(false);
  };

  const insertFileMention = (filePath: string) => {
    const replaced = draft.replace(/(?:^|\s)@([^\s]*)$/, (full) => {
      const leading = full.startsWith(" ") || full.startsWith("\n") ? full[0] : "";
      return `${leading}@${filePath} `;
    });
    onDraftChange(replaced);
    setMentionQuery(null);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          onUploadImage(file);
          return;
        }
      }
    }
  };

  const effectiveAuthMode = activeSession?.authMode ?? authMode;
  const effectiveHarnessId = activeSession?.harnessId ?? harnessId;
  const activeHarness = harnesses.find((h) => h.id === effectiveHarnessId);
  const modelOptions = useMemo(() => {
    const base =
      activeHarness && activeHarness.models.length > 0
        ? [...activeHarness.models]
        : [...AVAILABLE_MODELS];
    if (model && !base.includes(model)) {
      base.unshift(model);
    }
    return base;
  }, [activeHarness, model]);
  const slashCommands = useMemo(() => {
    const modelCmds = modelOptions.slice(0, 8).map((m) => `/model ${m}`);
    return [...modelCmds, ...BASE_SLASH_COMMANDS];
  }, [modelOptions]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashOpen) return [];
    const prefix = draft.trim().toLowerCase();
    return slashCommands.filter((c) => !prefix.startsWith("/") || c.toLowerCase().startsWith(prefix));
  }, [draft, slashOpen, slashCommands]);
  const profileSuggestions = activeHarness?.agentProfiles ?? [];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-canvas)]">
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2 empty:hidden">
        {isSubagentView && activeAgent && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              {onBackToMain && (
                <button
                  type="button"
                  onClick={onBackToMain}
                  className="shrink-0 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
                >
                  {t("backToMain")}
                </button>
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-semibold text-[var(--text-primary)]">
                    {activeAgent.role}
                  </span>
                  {(() => {
                    const meta = getAgentStateMeta(activeAgent.state);
                    return (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeCls}`}
                      >
                        {t(meta.labelKey)}
                      </span>
                    );
                  })()}
                  {isReadOnlySubagent && (
                    <span className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)]">
                      {t("agentReadOnlyBanner")}
                    </span>
                  )}
                </div>
                {activeAgent.currentTool && (
                  <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]">
                    {activeAgent.currentTool}
                    {activeAgent.currentTarget ? `: ${activeAgent.currentTarget}` : ""}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {!tmuxAvailable && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            {t("tmuxUnavailableWarning")}
          </div>
        )}

        {concurrencyWarning && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
            {t("concurrencyWarning", {
              count: concurrencyWarning.activeCount,
              limit: concurrencyWarning.limit,
            })}
          </div>
        )}

        {isMirror && activeSession && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs">
            <div className="min-w-0">
              <div className="font-semibold text-indigo-800 dark:text-indigo-200">
                {t("mirrorBannerTitle", { origin: activeSession.origin })}
              </div>
              <div className="text-[11px] text-indigo-700/80 dark:text-indigo-200/80">
                {t("mirrorBannerSubtitle")}
              </div>
            </div>
            <button
              type="button"
              disabled={resuming}
              onClick={onContinueInWeb}
              className="shrink-0 rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50"
            >
              {resuming ? t("continuingInWeb") : t("continueInWeb")}
            </button>
          </div>
        )}

        {status === "waiting_permission" && !pendingInteraction && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <div className="font-semibold">{t("waitingPermissionBanner")}</div>
            {permissionPrompt?.message && (
              <div className="mt-0.5 text-[11px] opacity-90">
                {t("waitingPermissionDetail", { message: permissionPrompt.message })}
              </div>
            )}
          </div>
        )}

        {status === "running" &&
          activeSession &&
          (activeSession.tmuxSession || activeSession.harnessId === "opencode") && (
            <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              <span>
                {activeSession.tmuxSession
                  ? t("sessionRunningBanner", { tmux: activeSession.tmuxSession })
                  : t("sessionRunningGeneric")}
              </span>
            </div>
          )}

        {status === "stopped" && activeSession && !isMirror && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
            <span>{t("sessionStoppedBanner")}</span>
            <button
              type="button"
              disabled={resuming}
              onClick={onContinueInWeb}
              className="rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-primary)] disabled:opacity-50"
            >
              {resuming ? t("continuingInWeb") : t("resumeSession")}
            </button>
          </div>
        )}

        {showInlineContextBar && <ContextBar usage={usage} variant="card" />}
        <TaskTimeline tasks={tasks} />
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="mx-auto mt-12 max-w-md rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-center">
            {isSubagentView ? (
              <p className="text-xs text-[var(--text-muted)]">{t("agentStreamEmpty")}</p>
            ) : (
              <>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t("emptyChatTitle")}
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                  {t("emptyChatSubtitle")}
                </p>
              </>
            )}
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.kind === "harness_switched" && msg.switchedFrom && msg.switchedTo) {
              const fromName = t(getHarnessLabelKey(msg.switchedFrom));
              const toName = t(getHarnessLabelKey(msg.switchedTo));
              const label = msg.syncedTurnsRange
                ? t("harnessSwitchedWithRange", {
                    from: fromName,
                    to: toName,
                    fromSeq: msg.syncedTurnsRange.fromSeq,
                    toSeq: msg.syncedTurnsRange.toSeq,
                  })
                : t("harnessSwitchedDivider", { from: fromName, to: toName });
              return (
                <div key={msg.id} className="flex items-center gap-2 py-1">
                  <div className="h-px flex-1 bg-[var(--border-subtle)]" />
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                    <span>{label}</span>
                  </span>
                  <div className="h-px flex-1 bg-[var(--border-subtle)]" />
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`rounded-lg border px-3.5 py-2.5 ${
                  msg.role === "user"
                    ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
                    : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                }`}
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <span>{msg.role === "user" ? t("roleUser") : t("roleAssistant")}</span>
                  {msg.role === "assistant" && msg.harnessId && (
                    <HarnessBadge harnessId={msg.harnessId} compact />
                  )}
                  {msg.role === "assistant" && msg.model && (
                    <span className="font-mono text-[10px] font-normal normal-case text-[var(--text-muted)]">
                      {msg.model}
                    </span>
                  )}
                </div>
                {msg.text && <MarkdownContent text={msg.text} />}
                {msg.tools && msg.tools.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {msg.tools.map((tool) => (
                      <ToolCallBlock
                        key={tool.id}
                        block={tool}
                        changesFiles={changesFiles}
                        onInspectFileChange={onInspectFileChange}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {pendingInteraction && (
        <div className="mx-4 mb-2">
          <InteractionCard
            interaction={pendingInteraction}
            submitting={submittingInteraction}
            onSubmitDecision={onSubmitDecision}
            onSubmitQuestion={onSubmitQuestion}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
      )}

      {error && (
        <div className="mx-4 mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <span className="font-semibold">{t("errorPrefix")}: </span>
          {error}
        </div>
      )}

      <footer className="relative border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        {isReadOnlySubagent ? (
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span>{t("agentReadOnlyDesc")}</span>
            {onBackToMain && (
              <button
                type="button"
                onClick={onBackToMain}
                className="rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary-fg)]"
              >
                {t("backToMain")}
              </button>
            )}
          </div>
        ) : (
          <>
        {(slashOpen && filteredSlashCommands.length > 0) && (
          <div className="absolute right-4 bottom-full left-4 z-20 mb-1 max-w-sm rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] p-1 shadow-lg">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t("slashCommandsTitle")}
            </div>
            {filteredSlashCommands.map((cmd) => (
              <button
                key={cmd}
                type="button"
                onClick={() => insertSlashCommand(cmd)}
                className="block w-full rounded px-2 py-1 text-left font-mono text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
              >
                {cmd}
              </button>
            ))}
          </div>
        )}

        {mentionQuery !== null && mentionFiles.length > 0 && (
          <div className="absolute right-4 bottom-full left-4 z-20 mb-1 max-h-48 max-w-md overflow-y-auto rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] p-1 shadow-lg">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t("fileMentionsTitle")}
            </div>
            {mentionFiles.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => insertFileMention(f.path)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
              >
                <span className="truncate">{f.path}</span>
                {f.isDir && (
                  <span className="text-[10px] text-[var(--text-muted)]">
                    {t("directoryBadge")}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="mx-auto max-w-4xl space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {!activeSession && harnesses.length > 0 && (
              <HarnessPicker
                harnesses={harnesses}
                value={harnessId}
                disabled={sending}
                onChange={(next) => onHarnessChange?.(next)}
              />
            )}

            <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span>{t("modelLabel")}</span>
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value as ModelId)}
                disabled={isBusy || sending || isMirror}
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            {!activeSession ? (
              <>
                <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                  <span>{t("authModeLabel")}</span>
                  <select
                    value={authMode}
                    onChange={(e) => onAuthModeChange(e.target.value as AuthMode)}
                    disabled={sending}
                    title={!apiKeyConfigured ? t("authApiKeyUnavailable") : undefined}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
                  >
                    <option value="machine_default">{t("authMachineDefault")}</option>
                    <option value="api_key" disabled={!apiKeyConfigured}>
                      {t("authApiKey")}
                    </option>
                  </select>
                </label>

                <label className="flex min-w-[180px] flex-1 items-center gap-1.5 text-[var(--text-secondary)]">
                  <span className="shrink-0">{t("cwdLabel")}</span>
                  <input
                    type="text"
                    list="hw-recent-cwds"
                    value={cwd}
                    onChange={(e) => onCwdChange(e.target.value)}
                    placeholder={t("cwdPlaceholder")}
                    disabled={sending}
                    className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                  />
                  <datalist id="hw-recent-cwds">
                    {recentCwds.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </label>

                {onOpenWorktreeModal && (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={onOpenWorktreeModal}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    {activeWorktree && !activeWorktree.isMain && activeWorktree.branch
                      ? t("worktreeBadge", { branch: activeWorktree.branch })
                      : t("worktreeButton")}
                  </button>
                )}

                <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                  <span className="shrink-0">{t("agentProfileLabel")}</span>
                  <input
                    type="text"
                    list="hw-agent-profiles"
                    value={agentProfile}
                    onChange={(e) => onAgentProfileChange(e.target.value)}
                    placeholder={t("agentProfilePlaceholder")}
                    disabled={sending}
                    className="w-32 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                  />
                  {profileSuggestions.length > 0 && (
                    <datalist id="hw-agent-profiles">
                      {profileSuggestions.map((p) => (
                        <option key={p} value={p} />
                      ))}
                    </datalist>
                  )}
                </label>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {harnesses.length > 0 && onSwitchHarness ? (
                  <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <span>{t("switchHarnessLabel")}</span>
                    <select
                      aria-label={t("switchHarnessLabel")}
                      value={activeSession.harnessId}
                      disabled={(!isMirror && isBusy) || sending || switchingHarness || isReadOnlySubagent}
                      onChange={(e) => onSwitchHarness(e.target.value as HarnessId)}
                      className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] outline-none disabled:opacity-50"
                    >
                      {harnesses.map((h) => {
                        const label = t(getHarnessLabelKey(h.id));
                        return (
                          <option
                            key={h.id}
                            value={h.id}
                            disabled={!h.available && h.id !== activeSession.harnessId}
                          >
                            {switchingHarness && h.id === activeSession.harnessId
                              ? t("switchingHarness")
                              : h.available || h.id === activeSession.harnessId
                                ? label
                                : `${label} (${t("harnessUnavailable", { name: label })})`}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : (
                  <HarnessBadge harnessId={activeSession.harnessId} compact />
                )}

                {activeSession.syncSummary && (
                  <>
                    {(activeSession.syncSummary.largeContextWarning ||
                      activeSession.syncSummary.lastSyncStrategy === "file_sync") && (
                      <Badge
                        variant="amber"
                        title={
                          activeSession.syncSummary.lastSyncFilePath
                            ? t("syncFileSavedHint", {
                                path: activeSession.syncSummary.lastSyncFilePath,
                              })
                            : undefined
                        }
                      >
                        {t("syncLargeContextBadge")}
                      </Badge>
                    )}
                    {activeSession.syncSummary.pendingSyncCount > 0 ? (
                      <Badge variant="amber">
                        {activeSession.syncSummary.pendingSyncFromSeq !== undefined &&
                        activeSession.syncSummary.pendingSyncToSeq !== undefined
                          ? t("syncStatusPendingRange", {
                              from: activeSession.syncSummary.pendingSyncFromSeq,
                              to: activeSession.syncSummary.pendingSyncToSeq,
                            })
                          : t("syncStatusPending", {
                              count: activeSession.syncSummary.pendingSyncCount,
                            })}
                      </Badge>
                    ) : (
                      (Object.keys(activeSession.syncSummary.bindings).length > 1 ||
                        activeSession.syncSummary.latestSeq > 0) && (
                        <Badge variant="emerald">{t("syncStatusSynced")}</Badge>
                      )
                    )}
                  </>
                )}

                <Badge variant={effectiveAuthMode === "api_key" ? "indigo" : "secondary"}>
                  {effectiveAuthMode === "api_key" ? t("authApiKey") : t("authMachineDefault")}
                </Badge>
                {activeSession.agentProfile && (
                  <span className="rounded bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                    @{activeSession.agentProfile}
                  </span>
                )}
                {onOpenWorktreeModal && (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={onOpenWorktreeModal}
                    className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    {activeWorktree && !activeWorktree.isMain && activeWorktree.branch
                      ? t("worktreeBadge", { branch: activeWorktree.branch })
                      : t("worktreeButton")}
                  </button>
                )}
              </div>
            )}

            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                disabled={isMirror}
                onClick={() => setSlashOpen((v) => !v)}
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                {t("slashButtonLabel")}
              </button>
              <button
                type="button"
                disabled={isMirror}
                onClick={() => onDraftChange(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`)}
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                {t("mentionButtonLabel")}
              </button>
              <button
                type="button"
                disabled={isMirror || uploadingImage}
                onClick={() => fileInputRef.current?.click()}
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                {uploadingImage ? t("uploadingImage") : t("uploadImage")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUploadImage(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSlashOpen(false);
                  setMentionQuery(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={isMirror ? t("mirrorPromptPlaceholder") : t("promptPlaceholder")}
              disabled={sending || isMirror}
              className="max-h-40 min-h-[44px] flex-1 resize-y rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)] focus:outline-none disabled:opacity-60"
            />
            {isBusy ? (
              <button
                type="button"
                onClick={onAbort}
                className="h-[44px] shrink-0 rounded-md bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700"
              >
                {t("stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={sending || isMirror || !draft.trim()}
                className="h-[44px] shrink-0 rounded-md bg-[var(--accent-primary)] px-4 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50"
              >
                {sending ? t("sending") : t("send")}
              </button>
            )}
          </div>
        </div>
          </>
        )}
      </footer>
    </section>
  );
}
