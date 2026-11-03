import type { UsageState } from "../hooks/useChat.ts";

export default function ContextBar({ usage }: { usage: UsageState }) {
  const used = usage.inputTokens + usage.outputTokens;
  const pct = usage.contextWindow > 0 ? Math.min(100, (used / usage.contextWindow) * 100) : 0;
  return (
    <div className="rounded border border-neutral-700 p-2 text-xs">
      <div className="mb-1 flex justify-between text-neutral-400">
        <span>
          context {used.toLocaleString()} / {usage.contextWindow.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
        {usage.costUsd !== undefined && <span>${usage.costUsd.toFixed(4)}</span>}
      </div>
      <div className="h-2 w-full rounded bg-neutral-800">
        <div
          className="h-2 rounded bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
