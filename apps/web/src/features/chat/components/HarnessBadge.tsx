import type { HarnessId } from "@contracts/harness";
import { Badge } from "@/components/ui/badge.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";
import type { TranslationKey } from "../../../lib/i18n/locales/en.ts";

interface HarnessStyle {
  labelKey: TranslationKey;
  variant: "amber" | "indigo" | "emerald";
  dotCls: string;
}

const HARNESS_STYLES: Record<HarnessId, HarnessStyle> = {
  claude: {
    labelKey: "harnessClaude",
    variant: "amber",
    dotCls: "bg-amber-500",
  },
  agy: {
    labelKey: "harnessAgy",
    variant: "indigo",
    dotCls: "bg-indigo-500",
  },
  opencode: {
    labelKey: "harnessOpencode",
    variant: "emerald",
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

/** Semantic harness pill badge for Claude, Antigravity, and OpenCode. */
export default function HarnessBadge({
  harnessId = "claude",
  compact = false,
}: HarnessBadgeProps) {
  const { t } = useTranslation();
  const style = HARNESS_STYLES[harnessId] ?? HARNESS_STYLES.claude;

  return (
    <Badge
      variant={style.variant}
      className={compact ? "px-1 py-0.5 leading-none" : "px-1.5 py-0.5"}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dotCls}`} />
      <span>{t(style.labelKey)}</span>
    </Badge>
  );
}
