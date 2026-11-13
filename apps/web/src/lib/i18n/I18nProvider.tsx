import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { en, type TranslationKey, type TranslationMessages } from "./locales/en.ts";

export interface I18nContextValue {
  locale: "en";
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  formatRelativeTime: (iso: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    params[key] !== undefined ? String(params[key]) : "",
  );
}

export function I18nProvider({
  messages = en,
  children,
}: {
  messages?: TranslationMessages;
  children: ReactNode;
}) {
  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => {
      return interpolate(messages[key], params);
    },
    [messages],
  );

  const formatRelativeTime = useCallback(
    (iso: string) => {
      const ts = Date.parse(iso);
      if (Number.isNaN(ts)) return "";
      const diffSec = Math.round((ts - Date.now()) / 1000);
      const absSec = Math.abs(diffSec);
      if (absSec < 15) return messages.justNow;
      if (absSec < 60) return relativeFormatter.format(diffSec, "second");
      const diffMin = Math.round(diffSec / 60);
      if (Math.abs(diffMin) < 60) return relativeFormatter.format(diffMin, "minute");
      const diffHour = Math.round(diffMin / 60);
      if (Math.abs(diffHour) < 24) return relativeFormatter.format(diffHour, "hour");
      const diffDay = Math.round(diffHour / 24);
      return relativeFormatter.format(diffDay, "day");
    },
    [messages],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale: "en", t, formatRelativeTime }),
    [t, formatRelativeTime],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within I18nProvider");
  return ctx;
}
