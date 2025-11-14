'use client';

import { FileText, File, Image, Video, Music, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SearchResultItem } from '@/app/api/search/route';

interface SearchResultCardProps {
  result: SearchResultItem;
}

function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;

  if (mimeType.startsWith('text/')) return FileText;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gz')) {
    return Archive;
  }

  return File;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return '';

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffYears > 0) return `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
  if (diffMonths > 0) return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  return 'Just now';
}

function getParentFolder(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  parts.pop(); // Remove filename
  return parts.join('/') + '/';
}

export function SearchResultCard({ result }: SearchResultCardProps) {
  const Icon = getFileIcon(result.mimeType);
  const parentFolder = getParentFolder(result.path);
  const fileSize = formatFileSize(result.size);
  const relativeTime = formatRelativeTime(result.modifiedAt);

  // Strip HTML tags from snippet (Meilisearch might return <em> tags)
  const cleanSnippet = result.snippet
    .replace(/<em>/g, '')
    .replace(/<\/em>/g, '')
    .slice(0, 150);

  return (
    <button
      type="button"
      className={cn(
        'w-full text-left rounded-lg p-4 transition-colors',
        'bg-muted/30 hover:bg-muted/60',
        'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
      )}
      onClick={() => {
        // TODO: Navigate to file detail view
        console.log('Open file:', result.path);
      }}
    >
      <div className="flex items-start gap-3">
        {/* File icon */}
        <div className="flex-shrink-0 mt-0.5">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-1">
          {/* Filename */}
          <div className="flex items-baseline gap-2">
            <h3 className="font-medium text-foreground truncate">
              {result.name}
            </h3>
          </div>

          {/* Parent folder */}
          {parentFolder && (
            <p className="text-xs text-muted-foreground truncate">
              {parentFolder}
            </p>
          )}

          {/* Summary or snippet */}
          {result.summary ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {result.summary}
            </p>
          ) : cleanSnippet ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {cleanSnippet}...
            </p>
          ) : null}

          {/* Metadata row */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {/* Tags */}
            {result.tags && (
              <>
                <span className="truncate max-w-[200px]">{result.tags}</span>
                <span>•</span>
              </>
            )}

            {/* File size */}
            {fileSize && (
              <>
                <span>{fileSize}</span>
                <span>•</span>
              </>
            )}

            {/* Modified time */}
            <span>{relativeTime}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
