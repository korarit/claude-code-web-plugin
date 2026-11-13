import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useTranslation } from "../../../lib/i18n/index.ts";

export interface ConfirmDeleteModalProps {
  sessionName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirmation dialog before permanently deleting a session. */
export default function ConfirmDeleteModal({
  sessionName,
  onCancel,
  onConfirm,
}: ConfirmDeleteModalProps) {
  const { t } = useTranslation();

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm" closeLabel={t("closeDialog")}>
        <DialogHeader>
          <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
          <DialogDescription>{t("deleteConfirmBody", { name: sessionName })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {t("confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
