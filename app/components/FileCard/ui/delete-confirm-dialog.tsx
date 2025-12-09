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
  onDeleted?: () => void;
}

/**
 * Shared delete confirmation dialog
 * Handles the delete API call and page refresh
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  fileName,
  filePath,
  onDeleted,
}: DeleteConfirmDialogProps) {
  const handleConfirm = async () => {
    onOpenChange(false);

    const success = await deleteFile(filePath);
    if (success) {
      if (onDeleted) {
        onDeleted();
      } else {
        window.location.reload();
      }
    } else {
      alert('Failed to delete file. Please try again.');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {fileName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the file and all related data.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
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
