import { useEffect, useRef } from "react";
import { AVAILABLE_MODELS, type ModelId, type SessionInfo } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { ChatMessage, TaskEntry, UsageState } from "../hooks/useChat.ts";
import type { PermissionPromptPayload, SessionStatus } from "@contracts/chat";
import ContextBar from "./ContextBar.tsx";
import MarkdownContent from "./MarkdownContent.tsx";
import TaskTimeline from "./TaskTimeline.tsx";
import ToolCallBlock from "./ToolCallBlock.tsx";

export interface ChatPanelProps {
  activeSession?: SessionInfo;
  tmuxAvailable: boolean;
  model: ModelId;
  onModelChange: (model: ModelId) => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  messages: ChatMessage[];
  tasks: TaskEntry[];
  usage: UsageState;
  status: SessionStatus;
  permissionPrompt: PermissionPromptPayload | null;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onAbort: () => void;
  showInlineContextBar?: boolean;
}

export default function ChatPanel({
  activeSession,
  tmuxAvailable,
  model,
  onModelChange,
  cwd,
  onCwdChange,
  draft,
  onDraftChange,
  messages,
  tasks,
  usage,
  status,
  permissionPrompt,
  sending,
  error,
  onSend,
  onAbort,
  showInlineContextBar = false,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, status]);

  const isBusy = status === "running" || status === "waiting_permission";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-canvas)]">
      <div className="space-y-2 border-b border-[var(--border-subtle)] px-4 py-2 empty:hidden">
        {!tmuxAvailable && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            {t("tmuxUnavailableWarning")}
          </div>
        )}

        {status === "waiting_permission" && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            <div className="font-semibold">{t("waitingPermissionBanner")}</div>
            {permissionPrompt?.message && (
              <div className="mt-0.5 text-[11px] opacity-90">
                {t("waitingPermissionDetail", { message: permissionPrompt.message })}
              </div>
            )}
          </div>
        )}

        {status === "running" && activeSession?.tmuxSession && (
          <div className="flex items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <span>{t("sessionRunningBanner", { tmux: activeSession.tmuxSession })}</span>
          </div>
        )}

        {status === "stopped" && activeSession && (
          <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
            {t("sessionStoppedBanner")}
          </div>
        )}

        {showInlineContextBar && <ContextBar usage={usage} variant="card" />}
        <TaskTimeline tasks={tasks} />
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="mx-auto mt-12 max-w-md rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-center">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              {t("emptyChatTitle")}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
              {t("emptyChatSubtitle")}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg border px-3.5 py-2.5 ${
                msg.role === "user"
                  ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
                  : "border-[var(--border-subtle)] bg-[var(--bg-surface)]"
              }`}
            >
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {msg.role === "user" ? t("roleUser") : t("roleAssistant")}
              </div>
              {msg.text && <MarkdownContent text={msg.text} />}
              {msg.tools && msg.tools.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {msg.tools.map((tool) => (
                    <ToolCallBlock key={tool.id} block={tool} />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <span className="font-semibold">{t("errorPrefix")}: </span>
          {error}
        </div>
      )}

      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <div className="mx-auto max-w-4xl space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span>{t("modelLabel")}</span>
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value as ModelId)}
                disabled={isBusy || sending}
                className="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
              >
                {AVAILABLE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            {!activeSession && (
              <label className="flex min-w-[200px] flex-1 items-center gap-1.5 text-[var(--text-secondary)]">
                <span className="shrink-0">{t("cwdLabel")}</span>
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => onCwdChange(e.target.value)}
                  placeholder={t("cwdPlaceholder")}
                  disabled={sending}
                  className="min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                />
              </label>
            )}
          </div>

          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={t("promptPlaceholder")}
              disabled={sending}
              className="max-h-40 min-h-[44px] flex-1 resize-y rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)] focus:outline-none"
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
                disabled={sending || !draft.trim()}
                className="h-[44px] shrink-0 rounded-md bg-[var(--accent-primary)] px-4 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50"
              >
                {sending ? t("sending") : t("send")}
              </button>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
}
