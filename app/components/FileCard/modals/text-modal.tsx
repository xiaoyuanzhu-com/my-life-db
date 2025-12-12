import { useEffect, useState, lazy, Suspense } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { fetchFullContent } from '../utils';
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

  const displayText = fullContent || previewText;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] h-[90vh] w-full sm:max-w-2xl p-0 flex flex-col"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <div className="flex-1 min-h-0 overflow-hidden">
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
                language={getLanguageFromFilename(file.name)}
                readOnly
              />
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
