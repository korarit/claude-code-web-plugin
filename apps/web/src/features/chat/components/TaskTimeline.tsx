import { useTranslation } from "../../../lib/i18n/index.ts";
import type { TaskEntry } from "../hooks/useChat.ts";

export default function TaskTimeline({ tasks }: { tasks: TaskEntry[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;

  return (
    <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 text-xs">
      <div className="mb-1 font-semibold text-[var(--text-secondary)]">
        {t("tasksTitle", { count: tasks.length })}
      </div>
      <ul className="max-h-28 space-y-1 overflow-y-auto">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400">
              {task.tool}
            </span>
            <span className="truncate">{task.label}</span>
            {task.subAgent && (
              <span className="shrink-0 rounded bg-indigo-500/15 px-1 py-0.5 text-[10px] text-indigo-600 dark:text-indigo-300">
                {t("subagentBadge")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
