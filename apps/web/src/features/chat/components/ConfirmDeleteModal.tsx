import { useTranslation } from "../../../lib/i18n/index.ts";

export default function ConfirmDeleteModal({
  sessionName,
  onCancel,
  onConfirm,
}: {
  sessionName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 shadow-xl">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {t("deleteConfirmTitle")}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          {t("deleteConfirmBody", { name: sessionName })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
          >
            {t("confirmDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}
