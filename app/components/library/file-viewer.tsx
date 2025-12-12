import { useState, useEffect, useCallback, useRef } from 'react';
import { FileX, Download } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { CodeEditor, getLanguageFromFilename } from '~/components/code-editor';

interface FileViewerProps {
  filePath: string;
  onFileDataLoad?: (contentType: string) => void;
  onContentChange: (filePath: string, content: string, isDirty: boolean) => void;
  initialEditedContent?: string;
}

interface FileData {
  path: string;
  name: string;
  content?: string;
  contentType: string;
  size: number;
  modifiedAt: string;
}

function getFileType(contentType: string): 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'unknown' {
  if (contentType.startsWith('text/') || contentType === 'application/json') return 'text';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'pdf';
  return 'unknown';
}

export function FileViewer({ filePath, onFileDataLoad, onContentChange, initialEditedContent }: FileViewerProps) {
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const isInitialMount = useRef(true);

  const originalContentRef = useRef<string | undefined>(undefined);
  const initialEditedContentRef = useRef(initialEditedContent);

  useEffect(() => {
    initialEditedContentRef.current = initialEditedContent;
  }, [initialEditedContent]);

  const loadFile = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/raw/${filePath}`);

      if (!response.ok) {
        throw new Error('Failed to load file');
      }

      // Extract just the MIME type, stripping charset and other parameters
      const rawContentType = response.headers.get('content-type') || 'application/octet-stream';
      const contentType = rawContentType.split(';')[0].trim();
      const fileType = getFileType(contentType);

      // Extract filename from path
      const filenameMatch = filePath.match(/[^/]+$/);
      const filename = filenameMatch ? filenameMatch[0] : 'file';

      // For text files, decode the binary response as UTF-8
      if (fileType === 'text') {
        const text = await response.text();

        setFileData({
          path: filePath,
          name: filename,
          content: text,
          contentType,
          size: parseInt(response.headers.get('content-length') || '0'),
          modifiedAt: new Date().toISOString(),
        });

        const initialContent =
          isInitialMount.current && initialEditedContentRef.current !== undefined
            ? initialEditedContentRef.current
            : text;

        // Set both refs before updating state to avoid dirty state race condition
        originalContentRef.current = text;
        setEditedContent(initialContent);

        // Notify parent component with correct initial dirty state
        const initialIsDirty = initialContent !== text;
        onContentChange(filePath, initialContent, initialIsDirty);

        // Defer setting isInitialMount to false to the next tick
        // This ensures the content change effect doesn't run during initial load
        setTimeout(() => {
          isInitialMount.current = false;
        }, 0);

        // Notify parent component
        if (onFileDataLoad) {
          onFileDataLoad(contentType);
        }
      } else {
        // For binary files (images, videos, etc.)
        setFileData({
          path: filePath,
          name: filename,
          contentType,
          size: parseInt(response.headers.get('content-length') || '0'),
          modifiedAt: new Date().toISOString(),
        });

        // Notify parent component
        if (onFileDataLoad) {
          onFileDataLoad(contentType);
        }
      }
    } catch (err) {
      console.error('Failed to load file:', err);
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setIsLoading(false);
    }
  }, [filePath, onFileDataLoad, onContentChange]);

  useEffect(() => {
    isInitialMount.current = true;
    loadFile();
  }, [filePath, loadFile]); // Reload when filePath or loadFile changes

  // Notify parent of content changes (only when user edits, not on initial load)
  useEffect(() => {
    // Skip notification on initial mount since loadFile handles it
    if (originalContentRef.current === undefined || isInitialMount.current) return;

    const isDirty = editedContent !== originalContentRef.current;
    onContentChange(filePath, editedContent, isDirty);
  }, [editedContent, filePath, onContentChange]);

  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent);
  };

  const isDirty = originalContentRef.current !== undefined && editedContent !== originalContentRef.current;

  const handleSave = useCallback(async () => {
    if (!fileData || isSaving || !isDirty) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/raw/${filePath}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: editedContent,
      });

      if (!response.ok) {
        throw new Error('Failed to save file');
      }

      // Update the file data and original content reference
      setFileData(prev => (prev ? { ...prev, content: editedContent } : prev));
      originalContentRef.current = editedContent;

      // Notify parent that file is no longer dirty
      onContentChange(filePath, editedContent, false);
    } catch (err) {
      console.error('Failed to save file:', err);
      setError(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  }, [editedContent, fileData, filePath, isDirty, isSaving, onContentChange]);

  // Keyboard shortcut for save (Cmd+S or Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  const handleDownload = () => {
    // Create a link element and trigger download
    const link = document.createElement('a');
    link.href = `/raw/${filePath}`;
    link.download = fileData?.name || 'file';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading file...
      </div>
    );
  }

  if (error || !fileData) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <FileX className="w-12 h-12" />
        <p>{error || 'Failed to load file'}</p>
      </div>
    );
  }

  const fileType = getFileType(fileData.contentType);
  const fileUrl = `/raw/${filePath}`;

  return (
    <div className="h-full w-full min-w-0 flex flex-col">
      {fileType === 'text' && fileData.content !== undefined && (
        <div className="flex-1 min-h-0">
          <CodeEditor
            value={editedContent}
            onChange={handleContentChange}
            language={getLanguageFromFilename(fileData.name)}
            onSave={handleSave}
          />
        </div>
      )}

      {fileType !== 'text' && (
      <div className="flex-1 overflow-auto p-4">

        {fileType === 'image' && (
          <div className="flex items-center justify-center">
            <img
              src={fileUrl}
              alt={fileData.name}
              className="max-w-full h-auto"
            />
          </div>
        )}

        {fileType === 'video' && (
          <div className="flex items-center justify-center">
            <video
              controls
              playsInline
              className="max-w-full h-auto"
              preload="metadata"
              muted
            >
              <source src={fileUrl} type={fileData.contentType} />
              Your browser does not support the video tag.
            </video>
          </div>
        )}

        {fileType === 'audio' && (
          <div className="flex items-center justify-center">
            <audio
              controls
              className="w-full max-w-2xl"
              src={fileUrl}
            >
              Your browser does not support the audio tag.
            </audio>
          </div>
        )}

        {fileType === 'pdf' && (
          <div className="h-full">
            <iframe
              src={fileUrl}
              className="w-full h-full border-0"
              title={fileData.name}
            />
          </div>
        )}

        {fileType === 'unknown' && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
            <FileX className="w-12 h-12" />
            <p>Cannot preview this file type</p>
            <Button onClick={handleDownload}>
              <Download className="w-4 h-4 mr-2" />
              Download to view
            </Button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
