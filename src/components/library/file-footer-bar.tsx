'use client';

import { Info } from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect } from 'react';

interface FileFooterBarProps {
  filePath: string | null;
}

export function FileFooterBar({ filePath }: FileFooterBarProps) {
  const [mimeType, setMimeType] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setMimeType(null);
      return;
    }

    // Fetch file metadata to get MIME type
    fetch(`/api/library/file?path=${encodeURIComponent(filePath)}`, {
      method: 'HEAD',
    })
      .then((response) => {
        const contentType = response.headers.get('content-type');
        setMimeType(contentType);
      })
      .catch(() => {
        setMimeType(null);
      });
  }, [filePath]);

  if (!filePath) {
    return null;
  }

  // Encode the file path for URL
  const infoUrl = `/file/${filePath}`;

  return (
    <div className="flex items-center justify-between h-6 px-2 text-xs text-muted-foreground shrink-0">
      {mimeType && (
        <span className="font-mono">{mimeType}</span>
      )}
      <Link
        href={infoUrl}
        className="flex items-center gap-1.5 hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-accent"
        title="View file information and digests"
      >
        <Info className="w-3.5 h-3.5" />
        <span>Details</span>
      </Link>
    </div>
  );
}
