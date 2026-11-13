import { useTranslation } from "../../../lib/i18n/index.ts";
import type { UsageState } from "../hooks/useChat.ts";

export default function ContextBar({
  usage,
  variant = "card",
}: {
  usage: UsageState;
  variant?: "card" | "inline" | "strip";
}) {
  const { t } = useTranslation();
  const used = usage.inputTokens + usage.outputTokens;
  const pct = usage.contextWindow > 0 ? Math.min(100, (used / usage.contextWindow) * 100) : 0;

  if (variant === "strip") {
    return (
      <div className="h-[3px] w-full bg-[var(--bg-muted)]">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <span>
          {t("contextLabel", {
            used: used.toLocaleString(),
            total: usage.contextWindow.toLocaleString(),
            pct: pct.toFixed(0),
          })}
        </span>
        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--bg-muted)]">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        {usage.costUsd !== undefined && (
          <span className="font-mono text-[11px] text-[var(--text-muted)]">
            ${usage.costUsd.toFixed(4)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 text-xs">
      <div className="mb-1 flex justify-between text-[var(--text-secondary)]">
        <span>
          {t("contextLabel", {
            used: used.toLocaleString(),
            total: usage.contextWindow.toLocaleString(),
            pct: pct.toFixed(1),
          })}
        </span>
        {usage.costUsd !== undefined && (
          <span className="font-mono text-[var(--text-muted)]">${usage.costUsd.toFixed(4)}</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-muted)]">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
