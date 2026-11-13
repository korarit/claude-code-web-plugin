import { useEffect, useState } from "react";
import type { PendingInteraction, PermissionDecision } from "@contracts/chat";
import { useTranslation } from "../../../lib/i18n/index.ts";

export interface InteractionCardProps {
  interaction: PendingInteraction;
  submitting: boolean;
  onSubmitDecision: (decision: PermissionDecision) => void;
  onSubmitQuestion: (answers: Record<string, string | string[]>) => void;
  onOpenTerminal?: () => void;
}

export default function InteractionCard({
  interaction,
  submitting,
  onSubmitDecision,
  onSubmitQuestion,
  onOpenTerminal,
}: InteractionCardProps) {
  const { t } = useTranslation();
  const [singleAnswers, setSingleAnswers] = useState<Record<string, string>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<string, string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    const initialSingles: Record<string, string> = {};
    if (interaction.kind === "question") {
      for (const q of interaction.questions) {
        if (!q.multiSelect && q.options[0]) {
          initialSingles[q.id] = q.options[0].id;
        }
      }
    }
    setSingleAnswers(initialSingles);
    setMultiAnswers({});
    setCustomTexts({});
  }, [interaction]);

  if (interaction.kind === "permission") {
    return (
      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold text-amber-800 dark:text-amber-200">
              {t("permissionPromptTitle", { tool: interaction.toolName })}
            </div>
            {interaction.message && (
              <p className="mt-0.5 text-[11px] text-amber-900/80 dark:text-amber-200/85">
                {interaction.message}
              </p>
            )}
          </div>
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-500/15 dark:text-amber-200"
            >
              {t("openTerminalFallback")}
            </button>
          )}
        </div>

        {interaction.commandOrTarget && (
          <pre className="mt-2 max-h-24 overflow-x-auto rounded border border-amber-500/30 bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--text-primary)]">
            {interaction.commandOrTarget}
          </pre>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmitDecision("allow_once")}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {t("allowOnce")}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmitDecision("always_allow")}
            className="rounded-md border border-emerald-600/50 bg-emerald-600/15 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-600/25 disabled:opacity-50 dark:text-emerald-300"
          >
            {t("alwaysAllow")}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmitDecision("deny")}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {t("deny")}
          </button>
        </div>
      </div>
    );
  }

  const handleQuestionSubmit = () => {
    const payload: Record<string, string | string[]> = {};
    for (const q of interaction.questions) {
      if (q.multiSelect) {
        const selected = multiAnswers[q.id] ?? [];
        const custom = customTexts[q.id]?.trim();
        payload[q.id] = custom ? [...selected, custom] : selected;
      } else {
        const custom = customTexts[q.id]?.trim();
        payload[q.id] = custom || singleAnswers[q.id] || q.options[0]?.id || "";
      }
    }
    onSubmitQuestion(payload);
  };

  return (
    <div className="rounded-lg border border-amber-500/50 bg-[var(--bg-surface)] p-3 text-xs shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-amber-700 dark:text-amber-300">
          {t("questionCardTitle")}
        </span>
        {onOpenTerminal && (
          <button
            type="button"
            onClick={onOpenTerminal}
            className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
          >
            {t("openTerminalFallback")}
          </button>
        )}
      </div>

      <div className="mt-2.5 space-y-3">
        {interaction.questions.map((q) => {
          const selectedMulti = multiAnswers[q.id] ?? [];
          const selectedSingle = singleAnswers[q.id] ?? "";
          const customVal = customTexts[q.id] ?? "";

          return (
            <div key={q.id} className="space-y-1.5">
              {q.header && (
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {q.header}
                </div>
              )}
              <div className="font-medium text-[var(--text-primary)]">{q.prompt}</div>

              <div className="space-y-1">
                {q.options.map((opt) => {
                  const checked = q.multiSelect
                    ? selectedMulti.includes(opt.id)
                    : selectedSingle === opt.id;
                  return (
                    <label
                      key={opt.id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                        checked
                          ? "border-[var(--border-strong)] bg-[var(--bg-elevated)]"
                          : "border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)]/60"
                      }`}
                    >
                      <input
                        type={q.multiSelect ? "checkbox" : "radio"}
                        name={`q-${interaction.id}-${q.id}`}
                        checked={checked}
                        disabled={submitting}
                        onChange={() => {
                          if (q.multiSelect) {
                            setMultiAnswers((prev) => {
                              const current = prev[q.id] ?? [];
                              const next = current.includes(opt.id)
                                ? current.filter((x) => x !== opt.id)
                                : [...current, opt.id];
                              return { ...prev, [q.id]: next };
                            });
                          } else {
                            setSingleAnswers((prev) => ({ ...prev, [q.id]: opt.id }));
                            setCustomTexts((prev) => ({ ...prev, [q.id]: "" }));
                          }
                        }}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-[var(--text-primary)]">{opt.label}</div>
                        {opt.description && (
                          <div className="text-[11px] text-[var(--text-muted)]">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              {q.allowCustomText !== false && (
                <input
                  type="text"
                  value={customVal}
                  disabled={submitting}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomTexts((prev) => ({ ...prev, [q.id]: v }));
                    if (!q.multiSelect && v) {
                      setSingleAnswers((prev) => ({ ...prev, [q.id]: "" }));
                    }
                  }}
                  placeholder={t("customAnswerPlaceholder")}
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--border-strong)]"
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={submitting}
          onClick={handleQuestionSubmit}
          className="rounded-md bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50"
        >
          {submitting ? t("submittingAnswer") : t("submitAnswer")}
        </button>
      </div>
    </div>
  );
}
