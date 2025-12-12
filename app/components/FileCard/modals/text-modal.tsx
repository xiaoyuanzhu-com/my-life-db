import { useEffect, useState, lazy, Suspense, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { fetchFullContent, saveFileContent } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';

const CodeEditor = lazy(() =>
  import('~/components/code-editor').then((mod) => ({
    default: mod.CodeEditor,
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

  // Reset edited content when modal opens with new file
  useEffect(() => {
    if (open) {
      setEditedContent(null);
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

  const handleClose = useCallback((isOpen: boolean) => {
    if (!isOpen && hasUnsavedChanges) {
      const confirmed = window.confirm('You have unsaved changes. Are you sure you want to close?');
      if (!confirmed) return;
    }
    if (!isOpen) {
      setEditedContent(null);
    }
    onOpenChange(isOpen);
  }, [hasUnsavedChanges, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-[90vw] h-[90vh] w-full sm:max-w-2xl p-0 flex flex-col"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => handleClose(false)} />
        <div className="flex-1 min-h-0 overflow-hidden p-4">
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
              <CodeEditor
                value={displayText}
                onChange={handleChange}
                onSave={handleSave}
                language={getLanguageFromFilename(file.name)}
              />
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
