import type { AgentActivityState } from "@contracts/agents";

export interface AgentStateMeta {
  labelKey:
    | "agentStateThinking"
    | "agentStateReading"
    | "agentStateEditing"
    | "agentStateRunningCmd"
    | "agentStateWaiting"
    | "agentStateIdle"
    | "agentStateDone";
  badgeCls: string;
  ringCls: string;
  glyph: string;
}

export function getAgentStateMeta(state: AgentActivityState): AgentStateMeta {
  switch (state) {
    case "reading":
      return {
        labelKey: "agentStateReading",
        badgeCls: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
        ringCls: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300",
        glyph: "🔍",
      };
    case "editing":
      return {
        labelKey: "agentStateEditing",
        badgeCls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        ringCls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
        glyph: "✎",
      };
    case "running_cmd":
      return {
        labelKey: "agentStateRunningCmd",
        badgeCls: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
        ringCls: "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
        glyph: "$_",
      };
    case "waiting":
      return {
        labelKey: "agentStateWaiting",
        badgeCls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        ringCls:
          "border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-300 animate-pulse",
        glyph: "⏳",
      };
    case "done":
      return {
        labelKey: "agentStateDone",
        badgeCls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        ringCls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        glyph: "✓",
      };
    case "idle":
      return {
        labelKey: "agentStateIdle",
        badgeCls: "bg-[var(--bg-muted)] text-[var(--text-secondary)]",
        ringCls: "border-[var(--border-subtle)] bg-[var(--bg-muted)] text-[var(--text-muted)]",
        glyph: "●",
      };
    default:
      return {
        labelKey: "agentStateThinking",
        badgeCls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        ringCls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
        glyph: "◎",
      };
  }
}
