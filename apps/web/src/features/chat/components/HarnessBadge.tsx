import type { HarnessId } from "@contracts/harness";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { TranslationKey } from "../../../lib/i18n/locales/en.ts";

interface HarnessStyle {
  labelKey: TranslationKey;
  badgeCls: string;
  dotCls: string;
}

const HARNESS_STYLES: Record<HarnessId, HarnessStyle> = {
  claude: {
    labelKey: "harnessClaude",
    badgeCls:
      "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
    dotCls: "bg-amber-500",
  },
  agy: {
    labelKey: "harnessAgy",
    badgeCls:
      "border-indigo-500/30 bg-indigo-500/12 text-indigo-800 dark:text-indigo-300",
    dotCls: "bg-indigo-500",
  },
  opencode: {
    labelKey: "harnessOpencode",
    badgeCls:
      "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-300",
    dotCls: "bg-emerald-500",
  },
};

export interface HarnessBadgeProps {
  harnessId?: HarnessId;
  compact?: boolean;
}

export function getHarnessLabelKey(harnessId: HarnessId): TranslationKey {
  return HARNESS_STYLES[harnessId]?.labelKey ?? "harnessClaude";
}

export default function HarnessBadge({
  harnessId = "claude",
  compact = false,
}: HarnessBadgeProps) {
  const { t } = useTranslation();
  const style = HARNESS_STYLES[harnessId] ?? HARNESS_STYLES.claude;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${style.badgeCls} ${
        compact ? "px-1 py-0.5 text-[10px] leading-none" : "px-1.5 py-0.5 text-[10px]"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dotCls}`} />
      <span>{t(style.labelKey)}</span>
    </span>
  );
}
