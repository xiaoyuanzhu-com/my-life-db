import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { deleteFile } from '../utils';

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  filePath: string;
  /**
   * Called immediately when delete is confirmed (optimistic).
   * If the delete fails, onRestoreItem will be called.
   */
  onDeleted?: () => void;
  /**
   * Called when delete fails after optimistic removal.
   * Used to restore the item to the UI.
   */
  onRestoreItem?: () => void;
}

/**
 * Shared delete confirmation dialog
 * Supports optimistic UI: calls onDeleted immediately, then onRestoreItem on failure.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  fileName,
  filePath,
  onDeleted,
  onRestoreItem,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation(['data', 'common']);
  const handleConfirm = async () => {
    onOpenChange(false);

    // Optimistic: call onDeleted immediately (if provided)
    if (onDeleted) {
      onDeleted();
    }

    const success = await deleteFile(filePath);
    if (success) {
      // If no optimistic handler, fall back to page reload
      if (!onDeleted) {
        window.location.reload();
      }
      // Otherwise, optimistic delete already happened - nothing more to do
    } else {
      // Delete failed
      if (onRestoreItem) {
        // Optimistic mode: restore the item
        onRestoreItem();
        alert(t('data:file.delete.failed'));
      } else if (onDeleted) {
        // onDeleted was called but no restore handler - just show error
        alert(t('data:file.delete.failed'));
      } else {
        // Non-optimistic mode
        alert(t('data:file.delete.failed'));
      }
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('data:file.delete.title', { name: fileName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('data:file.delete.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
