import type { TaskEntry } from "../hooks/useChat.ts";

export default function TaskTimeline({ tasks }: { tasks: TaskEntry[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="rounded border border-neutral-700 p-2 text-xs">
      <div className="mb-1 font-semibold text-neutral-300">tasks / sub-agents ({tasks.length})</div>
      <ul className="max-h-32 space-y-1 overflow-y-auto">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-neutral-400">
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
              {t.tool}
            </span>
            <span className="truncate">{t.label}</span>
            {t.subAgent && <span className="text-amber-300">[sub]</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
