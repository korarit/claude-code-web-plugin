import { useTranslation } from "../../../lib/i18n/index.ts";
import { useTheme, type ThemePreference } from "../../../lib/theme/index.ts";

const OPTIONS: readonly { value: ThemePreference; labelKey: "themeSystem" | "themeLight" | "themeDark" }[] = [
  { value: "system", labelKey: "themeSystem" },
  { value: "light", labelKey: "themeLight" },
  { value: "dark", labelKey: "themeDark" },
];

export default function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label={t("themeAriaLabel")}
      className="inline-flex rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5 text-[11px]"
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              active
                ? "bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t(opt.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
