'use client';

import { useEffect } from 'react';
import { FileX, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCachedFile } from '@/hooks/use-cached-file';

interface FileViewerProps {
  filePath: string;
  onFileDataLoad?: (contentType: string) => void;
}

function getFileType(contentType: string): 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'unknown' {
  if (contentType.startsWith('text/') || contentType === 'application/json') return 'text';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'pdf';
  return 'unknown';
}

export function FileViewer({ filePath, onFileDataLoad }: FileViewerProps) {
  // Use cached file hook with React Query + IndexedDB
  const { data: fileData, isLoading, error } = useCachedFile(filePath);

  // Notify parent when file loads
  useEffect(() => {
    if (fileData && onFileDataLoad) {
      onFileDataLoad(fileData.contentType);
    }
  }, [fileData, onFileDataLoad]);

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
        <p>{error instanceof Error ? error.message : 'Failed to load file'}</p>
      </div>
    );
  }

  const fileType = getFileType(fileData.contentType);
  const fileUrl = `/raw/${filePath}`;

  return (
    <div className="h-full overflow-auto p-4">
        {fileType === 'text' && fileData.content && (
          <pre className="text-sm font-mono whitespace-pre-wrap break-words">
            {fileData.content}
          </pre>
        )}

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
              className="max-w-full h-auto"
              src={fileUrl}
            >
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
  );
}
