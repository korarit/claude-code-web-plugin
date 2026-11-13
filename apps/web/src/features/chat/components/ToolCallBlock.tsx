import { useState } from "react";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { ToolBlock } from "../hooks/useChat.ts";

export default function ToolCallBlock({ block }: { block: ToolBlock }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetails = block.input !== undefined && block.input !== null;

  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-xs">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-[var(--bg-muted)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            {block.tool}
          </span>
          <span className="truncate text-[var(--text-secondary)]">{block.summary}</span>
          {block.subAgent && (
            <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
              {t("subagentBadge")}
            </span>
          )}
        </div>
        {hasDetails && (
          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </button>
      {expanded && hasDetails && (
        <pre className="max-h-48 overflow-auto border-t border-[var(--border-subtle)] bg-[var(--code-bg)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
          {typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
