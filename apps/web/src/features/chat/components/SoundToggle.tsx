import { useTranslation } from "../../../lib/i18n/index.ts";

export interface SoundToggleProps {
  muted: boolean;
  onToggle: () => void;
}

export default function SoundToggle({ muted, onToggle }: SoundToggleProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={t("soundToggleAria")}
      aria-pressed={!muted}
      className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
        muted
          ? "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          : "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
      }`}
    >
      {muted ? t("soundMuted") : t("soundOn")}
    </button>
  );
}
