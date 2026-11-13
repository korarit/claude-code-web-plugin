import type { HarnessDescriptor, HarnessId } from "@contracts/harness";
import { useTranslation } from "../../../lib/i18n/index.ts";
import { getHarnessLabelKey } from "./HarnessBadge.tsx";

const DOT_CLS: Record<HarnessId, string> = {
  claude: "bg-amber-500",
  agy: "bg-indigo-500",
  opencode: "bg-emerald-500",
};

const ACTIVE_CLS: Record<HarnessId, string> = {
  claude:
    "border-amber-500/50 bg-amber-500/12 text-amber-900 dark:text-amber-200",
  agy:
    "border-indigo-500/50 bg-indigo-500/12 text-indigo-900 dark:text-indigo-200",
  opencode:
    "border-emerald-500/50 bg-emerald-500/12 text-emerald-900 dark:text-emerald-200",
};

export interface HarnessPickerProps {
  harnesses: HarnessDescriptor[];
  value: HarnessId;
  disabled?: boolean;
  onChange: (harnessId: HarnessId) => void;
}

export default function HarnessPicker({
  harnesses,
  value,
  disabled = false,
  onChange,
}: HarnessPickerProps) {
  const { t } = useTranslation();

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5"
      role="group"
      aria-label={t("harnessLabel")}
      title={t("harnessPickerHint")}
    >
      {harnesses.map((h) => {
        const selected = h.id === value;
        const isDisabled = disabled || !h.available;
        const label = t(getHarnessLabelKey(h.id));
        const dotCls = DOT_CLS[h.id] ?? "bg-[var(--text-muted)]";
        const activeCls =
          ACTIVE_CLS[h.id] ??
          "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]";

        return (
          <button
            key={h.id}
            type="button"
            disabled={isDisabled}
            aria-pressed={selected}
            title={!h.available ? t("harnessUnavailable", { name: label }) : h.binary}
            onClick={() => onChange(h.id)}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              selected
                ? `border ${activeCls}`
                : "border border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                h.available ? dotCls : "bg-[var(--text-muted)]"
              }`}
            />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
