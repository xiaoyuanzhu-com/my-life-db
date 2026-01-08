import { useState, useEffect } from 'react';
import { Share2, Trash2, X } from 'lucide-react';
import { Button } from '~/components/ui/button';
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
import { useSelection } from '~/contexts/selection-context';
import { cn } from '~/lib/utils';
import { deleteFile, canShare } from '~/components/FileCard/utils';

interface MultiSelectActionBarProps {
  onDeleted?: () => void;
}

export function MultiSelectActionBar({ onDeleted }: MultiSelectActionBarProps) {
  const { selectedPaths, clearSelection } = useSelection();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const selectedCount = selectedPaths.size;

  // Check if we can share files on this device
  useEffect(() => {
    async function checkShareSupport() {
      if (!canShare() || typeof navigator.canShare !== 'function') {
        setCanShareFiles(false);
        return;
      }

      // Create a dummy file to test if file sharing is supported
      try {
        const dummyFile = new File(['test'], 'test.txt', { type: 'text/plain' });
        const supported = navigator.canShare({ files: [dummyFile] });
        setCanShareFiles(supported);
      } catch {
        setCanShareFiles(false);
      }
    }

    checkShareSupport();
  }, []);

  async function handleShare() {
    if (selectedPaths.size === 0 || isSharing) return;

    setIsSharing(true);
    try {
      // Fetch all files as blobs
      const files = await Promise.all(
        Array.from(selectedPaths).map(async (path) => {
          const response = await fetch(`/raw/${path}`, { cache: 'force-cache' });
          if (!response.ok) throw new Error(`Failed to fetch ${path}`);
          const blob = await response.blob();
          const name = path.split('/').pop() || 'file';
          return new File([blob], name, { type: blob.type });
        })
      );

      // Share all files
      if (navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ files });
        clearSelection();
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Failed to share files:', error);
      }
    } finally {
      setIsSharing(false);
    }
  }

  async function handleDelete() {
    if (selectedPaths.size === 0 || isDeleting) return;

    setIsDeleting(true);
    try {
      // Delete all selected files
      const results = await Promise.all(
        Array.from(selectedPaths).map((path) => deleteFile(path))
      );

      const successCount = results.filter(Boolean).length;
      if (successCount > 0) {
        onDeleted?.();
      }

      clearSelection();
    } catch (error) {
      console.error('Failed to delete files:', error);
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  }

  return (
    <>
      <div
        className={cn(
          'rounded-xl border bg-muted',
          'flex items-center justify-between px-4 h-12'
        )}
      >
        {/* Selected count */}
        <span className="text-sm text-muted-foreground">
          {selectedCount} selected
        </span>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {canShareFiles && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 cursor-pointer"
              onClick={handleShare}
              disabled={isSharing || selectedCount === 0}
            >
              <Share2 className="h-4 w-4 mr-1.5" />
              Share
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-destructive hover:text-destructive cursor-pointer"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isDeleting || selectedCount === 0}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Delete
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 cursor-pointer"
            onClick={clearSelection}
          >
            <X className="h-4 w-4 mr-1.5" />
            Cancel
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedCount} item{selectedCount !== 1 ? 's' : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. {selectedCount === 1 ? 'This file' : 'These files'} will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
