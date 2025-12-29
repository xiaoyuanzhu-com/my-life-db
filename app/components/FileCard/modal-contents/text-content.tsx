import { useEffect, useState, lazy, Suspense, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
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
import { Button } from '~/components/ui/button';
import type { FileWithDigests } from '~/types/file-card';
import { fetchFullContent, saveFileContent } from '../utils';

const TextEditor = lazy(() =>
  import('~/components/text-editor').then((mod) => ({
    default: mod.TextEditor,
  }))
);


export interface TextContentHandle {
  /** Attempt to close. Returns true if closed, false if blocked by unsaved changes dialog. */
  requestClose: () => boolean;
}

interface TextContentProps {
  file: FileWithDigests;
  /** Callback to notify parent of unsaved changes state */
  onDirtyStateChange?: (isDirty: boolean) => void;
  /** Called when close is confirmed (after save or discard) */
  onCloseConfirmed?: () => void;
}

export const TextContent = forwardRef<TextContentHandle, TextContentProps>(
  function TextContent({ file, onDirtyStateChange, onCloseConfirmed }, ref) {
    const [isLoading, setIsLoading] = useState(true);
    const [fullContent, setFullContent] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string | null>(null);
    const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);

    // Use ref for save handler so Monaco keybinding always calls latest version
    const saveHandlerRef = useRef<() => Promise<void>>(async () => {});

    const hasUnsavedChanges = editedContent !== null && editedContent !== fullContent;

    // Notify parent of dirty state changes
    useEffect(() => {
      onDirtyStateChange?.(hasUnsavedChanges);
    }, [hasUnsavedChanges, onDirtyStateChange]);

    // Load full content when file changes
    useEffect(() => {
      setIsLoading(true);
      setFullContent(null);
      setEditedContent(null);
      setIsCloseDialogOpen(false);

      fetchFullContent(file.path).then((content) => {
        setFullContent(content);
        setIsLoading(false);
      });
    }, [file.path]);

    const displayText = editedContent ?? fullContent ?? file.textPreview ?? '';

    const handleChange = useCallback((value: string) => {
      setEditedContent(value);
    }, []);

    const handleSave = useCallback(async () => {
      if (!editedContent) return;

      const success = await saveFileContent(file.path, editedContent);

      if (success) {
        setFullContent(editedContent);
        setEditedContent(null);
      }
    }, [editedContent, file.path]);

    // Keep ref updated with latest save handler
    useEffect(() => {
      saveHandlerRef.current = handleSave;
    }, [handleSave]);

    // Stable callback for Monaco that uses the ref
    const handleSaveFromEditor = useCallback(() => {
      saveHandlerRef.current?.();
    }, []);

    // Imperative handle for parent to request close
    useImperativeHandle(ref, () => ({
      requestClose: () => {
        if (hasUnsavedChanges) {
          setIsCloseDialogOpen(true);
          return false; // Blocked by dialog
        }
        return true; // Safe to close
      },
    }), [hasUnsavedChanges]);

    // Dialog actions
    const handleDiscard = useCallback(() => {
      setIsCloseDialogOpen(false);
      setEditedContent(null);
      onCloseConfirmed?.();
    }, [onCloseConfirmed]);

    const handleSaveAndClose = useCallback(async () => {
      if (editedContent) {
        const success = await saveFileContent(file.path, editedContent);
        if (success) {
          setFullContent(editedContent);
          setEditedContent(null);
        }
      }
      setIsCloseDialogOpen(false);
      onCloseConfirmed?.();
    }, [editedContent, file.path, onCloseConfirmed]);

    const handleCancelClose = useCallback(() => {
      setIsCloseDialogOpen(false);
    }, []);

    if (isLoading) {
      return (
        <div className="w-full h-full flex items-center justify-center bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] rounded-lg text-muted-foreground">
          Loading...
        </div>
      );
    }

    return (
      <>
        <div className="w-full h-full overflow-hidden bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] rounded-lg">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Loading editor...
              </div>
            }
          >
            <TextEditor
              value={displayText}
              onChange={handleChange}
              onSave={handleSaveFromEditor}
              filename={file.name}
            />
          </Suspense>
        </div>

        <AlertDialog open={isCloseDialogOpen} onOpenChange={setIsCloseDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes. What would you like to do?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleCancelClose}>Cancel</AlertDialogCancel>
              <Button variant="destructive" onClick={handleDiscard}>Discard</Button>
              <AlertDialogAction onClick={handleSaveAndClose}>Save</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
);
