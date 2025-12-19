import { useEffect, useState, lazy, Suspense, useCallback, useRef } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { fetchFullContent, saveFileContent } from '../utils';

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

interface TextContentProps {
  file: FileWithDigests;
  /** Callback to notify parent of unsaved changes state */
  onDirtyStateChange?: (isDirty: boolean) => void;
  /** Callback to provide close handler for unsaved changes confirmation */
  onCloseHandlerReady?: (handler: () => boolean) => void;
}

export function TextContent({ file, onDirtyStateChange, onCloseHandlerReady }: TextContentProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);

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

  // Provide close handler that checks for unsaved changes
  useEffect(() => {
    if (onCloseHandlerReady) {
      const closeHandler = (): boolean => {
        // Return true if safe to close, false if there are unsaved changes
        return !hasUnsavedChanges;
      };
      onCloseHandlerReady(closeHandler);
    }
  }, [hasUnsavedChanges, onCloseHandlerReady]);

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] rounded-lg text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
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
          language={getLanguageFromFilename(file.name)}
        />
      </Suspense>
    </div>
  );
}
