'use client';

import { Info } from 'lucide-react';
import Link from 'next/link';

interface FileFooterBarProps {
  filePath: string | null;
}

export function FileFooterBar({ filePath }: FileFooterBarProps) {
  if (!filePath) {
    return null;
  }

  // Encode the file path for URL
  const infoUrl = `/file/${filePath}`;

  return (
    <div className="flex items-center justify-end h-6 px-2 text-xs text-muted-foreground shrink-0">
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
