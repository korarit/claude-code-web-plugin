import { useState } from "react";
import type { AgentActivityState, AgentNode, TeamTaskItem, TeamTaskStatus } from "@contracts/agents";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { getAgentStateMeta } from "../agentStateMeta.ts";

const numberFormatter = new Intl.NumberFormat("en");

function isWorkingState(state: AgentActivityState): boolean {
  return (
    state === "thinking" ||
    state === "reading" ||
    state === "editing" ||
    state === "running_cmd"
  );
}

export interface AgentBoardProps {
  hasSession: boolean;
  agents: AgentNode[];
  tasks: TeamTaskItem[];
  activeAgentId?: string;
  loading: boolean;
  onInspectAgent: (agentId: string) => void;
  onBackToMain: () => void;
  onInspectAgentChanges: (agentId: string) => void;
}

export default function AgentBoard({
  hasSession,
  agents,
  tasks,
  activeAgentId,
  loading,
  onInspectAgent,
  onBackToMain,
  onInspectAgentChanges,
}: AgentBoardProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"grid" | "activity">("grid");

  if (!hasSession) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-surface)] p-6 text-center text-xs text-[var(--text-muted)]">
        {t("agentsEmpty")}
      </div>
    );
  }

  const taskGroups: Array<{ status: TeamTaskStatus; label: string; badgeCls: string }> = [
    {
      status: "pending",
      label: t("taskColPending"),
      badgeCls: "bg-[var(--bg-muted)] text-[var(--text-secondary)]",
    },
    {
      status: "in_progress",
      label: t("taskColInProgress"),
      badgeCls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    {
      status: "completed",
      label: t("taskColCompleted"),
      badgeCls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--bg-surface)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-xs font-semibold text-[var(--text-primary)]">{t("agentsTitle")}</span>
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "grid" | "activity")}>
          <TabsList className="text-[10px]">
            <TabsTrigger value="grid" className="px-2 py-0.5 text-[10px]">
              {t("agentViewGrid")}
            </TabsTrigger>
            <TabsTrigger value="activity" className="px-2 py-0.5 text-[10px]">
              {t("agentViewActivity")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Agents Section */}
        {loading && agents.length === 0 ? (
          <div className="py-6 text-center text-xs text-[var(--text-muted)]">
            {t("loadingText")}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4 text-center text-xs text-[var(--text-muted)]">
            {t("agentsEmpty")}
          </div>
        ) : viewMode === "activity" ? (
          <div className="grid grid-cols-1 gap-2">
            {agents.map((agent) => {
              const meta = getAgentStateMeta(agent.state);
              const selected =
                (activeAgentId ?? "main") === agent.agentId ||
                (!activeAgentId && agent.agentId === "main");
              const working = isWorkingState(agent.state);
              return (
                <div
                  key={agent.agentId}
                  className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                    selected
                      ? "border-[var(--accent-primary)] bg-[var(--bg-elevated)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
                  }`}
                >
                  <div
                    className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border font-mono text-sm font-bold ${meta.ringCls}`}
                  >
                    <span>{meta.glyph}</span>
                    {working && (
                      <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-amber-500/70" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                        {agent.agentId === "main" ? t("agentMainRole") : agent.role}
                      </span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeCls}`}>
                        {t(meta.labelKey)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]">
                      {agent.currentTool
                        ? `${agent.currentTool}${agent.currentTarget ? `: ${agent.currentTarget}` : ""}`
                        : agent.recentLogs?.[agent.recentLogs.length - 1] ?? t("agentNoLogs")}
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      {agent.agentId === "main" ? (
                        activeAgentId && activeAgentId !== "main" && (
                          <button
                            type="button"
                            onClick={onBackToMain}
                            className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                          >
                            {t("backToMain")}
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => onInspectAgent(agent.agentId)}
                          className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
                        >
                          {t("inspectStream")}
                        </button>
                      )}
                      {agent.agentId !== "main" && (
                        <button
                          type="button"
                          onClick={() => onInspectAgentChanges(agent.agentId)}
                          className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          {t("viewAgentChanges")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5">
            {agents.map((agent) => {
              const meta = getAgentStateMeta(agent.state);
              const selected =
                (activeAgentId ?? "main") === agent.agentId ||
                (!activeAgentId && agent.agentId === "main");
              const working = isWorkingState(agent.state);
              const totalTokens =
                (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0);
              const logs = agent.recentLogs?.slice(-3) ?? [];

              return (
                <div
                  key={agent.agentId}
                  className={`rounded-lg border p-3 transition-colors ${
                    selected
                      ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
                      : "border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {working ? (
                        <svg
                          className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="3"
                          />
                          <path
                            className="opacity-85"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
                          />
                        </svg>
                      ) : (
                        <span className="font-mono text-xs text-[var(--text-muted)]">
                          {meta.glyph}
                        </span>
                      )}
                      <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                        {agent.agentId === "main" ? t("agentMainRole") : agent.role}
                      </span>
                      {agent.agentType && (
                        <span className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                          {agent.agentType}
                        </span>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {totalTokens > 0 && (
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          {t("agentTokens", { count: numberFormatter.format(totalTokens) })}
                        </span>
                      )}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.badgeCls}`}>
                        {t(meta.labelKey)}
                      </span>
                    </div>
                  </div>

                  {agent.currentTool && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded bg-[var(--bg-surface)] px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)]">
                      <span className="shrink-0 font-semibold text-[var(--text-primary)]">
                        {agent.currentTool}
                      </span>
                      {agent.currentTarget && (
                        <span className="min-w-0 truncate text-[var(--text-muted)]">
                          {agent.currentTarget}
                        </span>
                      )}
                    </div>
                  )}

                  {logs.length > 0 && (
                    <div className="mt-2 space-y-0.5 border-l-2 border-[var(--border-subtle)] pl-2">
                      {logs.map((line, idx) => (
                        <div
                          key={`${agent.agentId}-log-${idx}`}
                          className="truncate font-mono text-[10px] text-[var(--text-muted)]"
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {agent.agentId === "main" ? (
                      activeAgentId &&
                      activeAgentId !== "main" && (
                        <button
                          type="button"
                          onClick={onBackToMain}
                          className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1 text-[10px] font-medium text-[var(--text-primary)]"
                        >
                          {t("backToMain")}
                        </button>
                      )
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onInspectAgent(agent.agentId)}
                          className="rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2 py-1 text-[10px] font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]"
                        >
                          {t("inspectStream")}
                        </button>
                        <button
                          type="button"
                          onClick={() => onInspectAgentChanges(agent.agentId)}
                          className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                          {t("viewAgentChanges")}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Shared Task Board */}
        <div className="border-t border-[var(--border-subtle)] pt-3">
          <div className="mb-2 text-xs font-semibold text-[var(--text-primary)]">
            {t("taskBoardTitle", { count: tasks.length })}
          </div>
          {tasks.length === 0 ? (
            <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-center text-[11px] text-[var(--text-muted)]">
              {t("taskBoardEmpty")}
            </div>
          ) : (
            <div className="space-y-2.5">
              {taskGroups.map((group) => {
                const groupItems = tasks.filter((item) => item.status === group.status);
                if (groupItems.length === 0) return null;
                return (
                  <div
                    key={group.status}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${group.badgeCls}`}>
                        {group.label}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--text-muted)]">
                        {groupItems.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {groupItems.map((item) => (
                        <div
                          key={`${item.source ?? "task"}-${item.id}`}
                          className="rounded border border-[var(--border-subtle)]/70 bg-[var(--bg-surface)] px-2 py-1.5 text-[11px]"
                        >
                          <div className="font-medium text-[var(--text-primary)]">{item.subject}</div>
                          {(item.owner || item.description) && (
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
                              {item.owner && <span>{t("taskOwner", { owner: item.owner })}</span>}
                              {item.description && <span className="truncate">{item.description}</span>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
