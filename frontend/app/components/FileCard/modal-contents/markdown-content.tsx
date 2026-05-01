import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Code as CodeIcon } from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import type { FileWithDigests } from '~/types/file-card';
import { fetchFullContent, saveFileContent } from '../utils';
import { TextEditor } from '~/components/text-editor';
import { parseMarkdown, parseMarkdownSync } from '~/lib/markdown';
import type { TextContentHandle } from './text-content';

type Mode = 'preview' | 'source';

const MODE_STORAGE_KEY = 'mld.filePreview.mode';

function getInitialMode(): Mode {
  if (typeof window === 'undefined') return 'preview';
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
  return stored === 'source' ? 'source' : 'preview';
}

function getDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

interface MarkdownContentProps {
  file: FileWithDigests;
  onDirtyStateChange?: (isDirty: boolean) => void;
  onCloseConfirmed?: () => void;
}

export const MarkdownContent = forwardRef<TextContentHandle, MarkdownContentProps>(
  function MarkdownContent({ file, onDirtyStateChange, onCloseConfirmed }, ref) {
    const { t } = useTranslation(['data', 'common']);
    const [isLoading, setIsLoading] = useState(true);
    const [fullContent, setFullContent] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string | null>(null);
    const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
    const [mode, setMode] = useState<Mode>(getInitialMode);
    const [renderedHtml, setRenderedHtml] = useState<string>('');

    const saveHandlerRef = useRef<() => Promise<void>>(async () => {});
    const hasUnsavedChanges = editedContent !== null && editedContent !== fullContent;
    const basePath = useMemo(() => getDirname(file.path), [file.path]);
    const sourceText = editedContent ?? fullContent ?? file.textPreview ?? '';

    useEffect(() => {
      onDirtyStateChange?.(hasUnsavedChanges);
    }, [hasUnsavedChanges, onDirtyStateChange]);

    useEffect(() => {
      setIsLoading(true);
      setFullContent(null);
      setEditedContent(null);
      setIsCloseDialogOpen(false);
      setRenderedHtml('');

      fetchFullContent(file.path).then((content) => {
        setFullContent(content);
        setIsLoading(false);
      });
    }, [file.path]);

    // Render markdown when in preview mode (and content is loaded).
    useEffect(() => {
      if (mode !== 'preview') return;
      if (fullContent === null && !file.textPreview) return;

      let cancelled = false;
      // Show a fast sync render immediately, then upgrade with the async (Shiki + mermaid) render.
      const sync = parseMarkdownSync(sourceText, { basePath });
      setRenderedHtml(sync);
      parseMarkdown(sourceText, { basePath })
        .then((html) => {
          if (!cancelled) setRenderedHtml(html);
        })
        .catch(() => {
          // Keep the sync render on async failure
        });
      return () => {
        cancelled = true;
      };
    }, [mode, sourceText, basePath, fullContent, file.textPreview]);

    const setModePersisted = useCallback((next: Mode) => {
      setMode(next);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MODE_STORAGE_KEY, next);
      }
    }, []);

    const handleChange = useCallback((value: string) => {
      setEditedContent(value);
    }, []);

    const handleSave = useCallback(async () => {
      if (editedContent === null) return;
      const success = await saveFileContent(file.path, editedContent);
      if (success) {
        setFullContent(editedContent);
        setEditedContent(null);
      }
    }, [editedContent, file.path]);

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
      if (editedContent !== null) {
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
        <div className="relative w-full h-full overflow-hidden bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] rounded-lg">
          {mode === 'preview' ? (
            <div
              className="markdown-content w-full h-full overflow-auto px-8 py-6 text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            <TextEditor
              value={sourceText}
              onChange={handleChange}
              onSave={handleSaveFromEditor}
              filename={file.name}
            />
          )}

          <ModeToggle mode={mode} onChange={setModePersisted} />
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

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const next: Mode = mode === 'preview' ? 'source' : 'preview';
  const Icon = mode === 'preview' ? CodeIcon : Eye;
  const label = mode === 'preview' ? 'View source' : 'View preview';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onChange(next)}
          aria-label={label}
          className="absolute top-3 right-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md bg-background/80 backdrop-blur-sm text-muted-foreground shadow-sm hover:text-foreground hover:bg-background transition-colors"
        >
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
