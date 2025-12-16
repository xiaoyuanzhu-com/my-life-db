import { useEffect, useState, lazy, Suspense, useCallback, useRef } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
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
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Button } from '~/components/ui/button';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { fetchFullContent, saveFileContent, downloadFile, shareText, canShare } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';

type ModalView = 'content' | 'digests';

const TextEditor = lazy(() =>
  import('~/components/text-editor').then((mod) => ({
    default: mod.TextEditor,
  }))
);

const getLanguageFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    html: 'html',
    css: 'css',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    sh: 'shell',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    sql: 'sql',
  };
  return languageMap[ext || ''] || 'plaintext';
};

interface TextModalProps extends BaseModalProps {
  previewText: string;
  fullContent: string | null;
  onFullContentLoaded: (content: string) => void;
}

export function TextModal({
  file,
  open,
  onOpenChange,
  previewText,
  fullContent,
  onFullContentLoaded,
}: TextModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [activeView, setActiveView] = useState<ModalView>('content');

  // Use ref for save handler so Monaco keybinding always calls latest version
  const saveHandlerRef = useRef<() => Promise<void>>(async () => {});

  // Reset state when modal opens with new file
  useEffect(() => {
    if (open) {
      setEditedContent(null);
      setActiveView('content');
    }
  }, [open, file.path]);

  useEffect(() => {
    if (open && !fullContent) {
      setIsLoading(true);
      fetchFullContent(file.path).then((content) => {
        if (content) {
          onFullContentLoaded(content);
        }
        setIsLoading(false);
      });
    }
  }, [open, fullContent, file.path, onFullContentLoaded]);

  const displayText = editedContent ?? fullContent ?? previewText;
  const hasUnsavedChanges = editedContent !== null && editedContent !== fullContent;

  const handleChange = useCallback((value: string) => {
    setEditedContent(value);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editedContent) return;

    const success = await saveFileContent(file.path, editedContent);

    if (success) {
      onFullContentLoaded(editedContent);
      setEditedContent(null);
    }
  }, [editedContent, file.path, onFullContentLoaded]);

  // Keep ref updated with latest save handler
  useEffect(() => {
    saveHandlerRef.current = handleSave;
  }, [handleSave]);

  // Stable callback for Monaco that uses the ref
  const handleSaveFromEditor = useCallback(() => {
    saveHandlerRef.current?.();
  }, []);

  const handleCloseClick = useCallback(() => {
    if (hasUnsavedChanges) {
      setIsCloseDialogOpen(true);
    } else {
      setEditedContent(null);
      onOpenChange(false);
    }
  }, [hasUnsavedChanges, onOpenChange]);

  const confirmClose = useCallback(() => {
    setIsCloseDialogOpen(false);
    setEditedContent(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const cancelClose = useCallback(() => {
    setIsCloseDialogOpen(false);
  }, []);

  const saveAndClose = useCallback(async () => {
    if (editedContent) {
      const success = await saveFileContent(file.path, editedContent);
      if (success) {
        onFullContentLoaded(editedContent);
      }
    }
    setIsCloseDialogOpen(false);
    setEditedContent(null);
    onOpenChange(false);
  }, [editedContent, file.path, onFullContentLoaded, onOpenChange]);

  // Handle Dialog's onOpenChange (e.g., pressing Escape)
  const handleDialogOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      handleCloseClick();
    }
  }, [handleCloseClick]);

  // Modal action handlers
  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    const textToShare = fullContent || previewText;
    shareText(file.name, textToShare);
  }, [file.name, fullContent, previewText]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => (prev === 'digests' ? 'content' : 'digests'));
  }, []);

  // Modal actions
  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          className={`h-[90vh] p-0 overflow-hidden border-0 ${
            showDigests ? 'max-w-[90vw] w-full' : 'max-w-[90vw] w-full sm:max-w-2xl'
          }`}
          showCloseButton={false}
        >
          <VisuallyHidden>
            <DialogTitle>{file.name}</DialogTitle>
          </VisuallyHidden>
          <ModalCloseButton onClick={handleCloseClick} isDirty={hasUnsavedChanges} />
          <ModalActionButtons actions={modalActions} />
          {/* Desktop: side-by-side, Mobile: horizontal scroll with snap */}
          <div className={`h-full w-full overflow-hidden rounded-lg ${
            showDigests
              ? 'flex overflow-x-auto snap-x snap-mandatory md:overflow-x-hidden'
              : 'flex'
          }`}>
            {/* Content view */}
            <div className={`h-full overflow-hidden bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex-shrink-0 ${
              showDigests ? 'w-full md:w-1/2 snap-center' : 'w-full'
            }`}>
              {isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Loading...
                </div>
              ) : (
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
                    language={getLanguageFromFilename(file.name)}
                  />
                </Suspense>
              )}
            </div>
            {/* Digests panel - Desktop: side-by-side, Mobile: next page */}
            {showDigests && (
              <div className="w-full md:w-1/2 h-full border-l border-border flex-shrink-0 snap-center">
                <DigestsPanel file={file} />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isCloseDialogOpen} onOpenChange={setIsCloseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. What would you like to do?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelClose}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={confirmClose}>Discard</Button>
            <AlertDialogAction onClick={saveAndClose}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
