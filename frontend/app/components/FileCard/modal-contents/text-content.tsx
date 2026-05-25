import { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
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
import { Button } from '~/components/ui/button';
import type { FileWithDigests } from '~/types/file-card';
import { fetchTextRange, saveFileContent } from '../utils';
import { TextEditor } from '~/components/text-editor';


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

// Files larger than this stay read-only and stream in 1 MB chunks via HTTP Range.
const LARGE_FILE_THRESHOLD = 1_048_576;
const CHUNK_SIZE = 1_048_576;
// Trigger the next chunk fetch when the scroll position is within this many
// pixels of the bottom of the loaded content.
const NEAR_BOTTOM_PX = 2000;

export const TextContent = forwardRef<TextContentHandle, TextContentProps>(
  function TextContent({ file, onDirtyStateChange, onCloseConfirmed }, ref) {
    const { t } = useTranslation(['data', 'common']);
    const [isLoading, setIsLoading] = useState(true);
    const [fullContent, setFullContent] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string | null>(null);
    const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
    const [loadedBytes, setLoadedBytes] = useState(0);
    const [totalBytes, setTotalBytes] = useState(0);

    const decoderRef = useRef<TextDecoder | null>(null);
    const loadingMoreRef = useRef(false);
    const saveHandlerRef = useRef<() => Promise<void>>(async () => {});

    const isLargeFile = totalBytes > LARGE_FILE_THRESHOLD;
    const hasUnsavedChanges =
      !isLargeFile && editedContent !== null && editedContent !== fullContent;

    useEffect(() => {
      onDirtyStateChange?.(hasUnsavedChanges);
    }, [hasUnsavedChanges, onDirtyStateChange]);

    useEffect(() => {
      let cancelled = false;
      setIsLoading(true);
      setFullContent(null);
      setEditedContent(null);
      setIsCloseDialogOpen(false);
      setLoadedBytes(0);
      setTotalBytes(0);
      loadingMoreRef.current = false;
      const decoder = new TextDecoder('utf-8');
      decoderRef.current = decoder;

      (async () => {
        const result = await fetchTextRange(file.path, 0, CHUNK_SIZE - 1, decoder);
        if (cancelled) return;
        if (!result) {
          setFullContent('');
          setIsLoading(false);
          return;
        }

        const bytesLoaded = result.totalSize > 0
          ? Math.min(CHUNK_SIZE, result.totalSize)
          : CHUNK_SIZE;

        // If we already have the whole file, flush any trailing partial UTF-8.
        let text = result.text;
        if (result.totalSize > 0 && bytesLoaded >= result.totalSize) {
          text += decoder.decode();
        }

        setFullContent(text);
        setLoadedBytes(bytesLoaded);
        setTotalBytes(result.totalSize);
        setIsLoading(false);
      })();

      return () => { cancelled = true; };
    }, [file.path]);

    const loadMoreChunk = useCallback(async () => {
      if (loadingMoreRef.current) return;
      const decoder = decoderRef.current;
      if (!decoder) return;
      if (totalBytes === 0 || loadedBytes >= totalBytes) return;

      loadingMoreRef.current = true;
      const start = loadedBytes;
      const end = Math.min(loadedBytes + CHUNK_SIZE, totalBytes) - 1;
      const result = await fetchTextRange(file.path, start, end, decoder);
      if (!result) {
        loadingMoreRef.current = false;
        return;
      }

      const newLoaded = end + 1;
      let text = result.text;
      if (newLoaded >= totalBytes) {
        text += decoder.decode();
      }

      setFullContent((prev) => (prev ?? '') + text);
      setLoadedBytes(newLoaded);
      loadingMoreRef.current = false;
    }, [file.path, loadedBytes, totalBytes]);

    const handleEditorScroll = useCallback(
      (info: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
        if (!isLargeFile) return;
        if (loadedBytes >= totalBytes) return;
        const distanceFromBottom = info.scrollHeight - info.scrollTop - info.clientHeight;
        if (distanceFromBottom <= NEAR_BOTTOM_PX) {
          loadMoreChunk();
        }
      },
      [isLargeFile, loadedBytes, totalBytes, loadMoreChunk],
    );

    const displayText = editedContent ?? fullContent ?? file.textPreview ?? '';

    const handleChange = useCallback((value: string) => {
      if (isLargeFile) return;
      setEditedContent(value);
    }, [isLargeFile]);

    const handleSave = useCallback(async () => {
      if (isLargeFile || !editedContent) return;

      const success = await saveFileContent(file.path, editedContent);

      if (success) {
        setFullContent(editedContent);
        setEditedContent(null);
      }
    }, [editedContent, file.path, isLargeFile]);

    useEffect(() => {
      saveHandlerRef.current = handleSave;
    }, [handleSave]);

    const handleSaveFromEditor = useCallback(() => {
      saveHandlerRef.current?.();
    }, []);

    useImperativeHandle(ref, () => ({
      requestClose: () => {
        if (hasUnsavedChanges) {
          setIsCloseDialogOpen(true);
          return false;
        }
        return true;
      },
    }), [hasUnsavedChanges]);

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
          <TextEditor
            value={displayText}
            onChange={isLargeFile ? undefined : handleChange}
            onSave={isLargeFile ? undefined : handleSaveFromEditor}
            onScroll={isLargeFile ? handleEditorScroll : undefined}
            filename={file.name}
            language={isLargeFile ? 'plaintext' : undefined}
            readOnly={isLargeFile}
          />
        </div>

        <AlertDialog open={isCloseDialogOpen} onOpenChange={setIsCloseDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('data:file.unsavedChanges')}</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes. What would you like to do?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleCancelClose}>{t('common:actions.cancel')}</AlertDialogCancel>
              <Button variant="destructive" onClick={handleDiscard}>{t('common:actions.discard')}</Button>
              <AlertDialogAction onClick={handleSaveAndClose}>{t('common:actions.save')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
);
