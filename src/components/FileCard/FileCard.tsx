'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { FileText, File, Image as ImageIcon, Video, Music, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileWithDigests } from '@/types/file-card';

export interface FileCardProps {
  file: FileWithDigests;
  variant?: 'card' | 'list';
  onClick?: () => void;
  className?: string;
  href?: string;             // If provided, wraps content in Link

  // Optional context-specific content
  primaryText?: string;      // For inbox: user input text
  snippet?: string;           // For search: highlighted excerpt
}

/**
 * Unified file card component
 * Used by both inbox and search results
 */
export function FileCard({
  file,
  variant = 'card',
  onClick,
  className,
  href,
  primaryText,
  snippet,
}: FileCardProps) {
  // Compute derived data from digests
  const summary = useMemo(() => {
    const summaryDigest = file.digests.find(d => d.type === 'summary');
    return summaryDigest?.content || null;
  }, [file.digests]);

  const tags = useMemo(() => {
    const tagsDigest = file.digests.find(d => d.type === 'tags');
    if (!tagsDigest?.content) return null;
    try {
      return JSON.parse(tagsDigest.content) as string[];
    } catch {
      return null;
    }
  }, [file.digests]);

  const screenshot = useMemo(() => {
    const screenshotDigest = file.digests.find(d => d.type === 'screenshot');
    if (!screenshotDigest?.sqlarName) return null;

    // Generate SQLAR API URL
    // Use simple base64 encoding and replace URL-unsafe characters (browser-compatible)
    const pathHash = btoa(file.path)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
      .slice(0, 12);

    return {
      src: `/api/inbox/sqlar/${pathHash}/screenshot/screenshot.png`,
      alt: 'Preview screenshot',
    };
  }, [file.digests, file.path]);

  const timeAgo = useMemo(() => {
    try {
      return formatDistanceToNow(new Date(file.createdAt), { addSuffix: true });
    } catch {
      return '';
    }
  }, [file.createdAt]);

  if (variant === 'card') {
    const cardContent = (
      <div
        className={cn(
          'group relative h-64 w-full overflow-hidden rounded-2xl border border-border bg-muted shadow-sm transition-all duration-300',
          'hover:-translate-y-1 hover:shadow-lg',
          className
        )}
      >
        {/* Screenshot background */}
        {screenshot && (
          <Image
            src={screenshot.src}
            alt={screenshot.alt}
            fill
            sizes="(max-width: 768px) 100vw, 33vw"
            className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
            priority={false}
          />
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-background via-background/75 to-background/40" />

        {/* Content */}
        <div className="relative z-10 flex h-full flex-col">
          <div className="p-4">
            {/* Primary text or summary */}
            {primaryText ? (
              <TextPreview
                text={primaryText}
                maxChars={220}
                className="text-base font-medium leading-7 text-foreground drop-shadow-[0_4px_18px_rgba(15,23,42,0.4)]"
              />
            ) : summary ? (
              <TextPreview
                text={summary}
                maxChars={220}
                className="text-sm leading-6 text-foreground/90"
              />
            ) : (
              <div className="text-sm text-muted-foreground/70 italic">
                {file.name}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="mt-auto px-4 pb-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground/90">
              <span className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm">
                {file.mimeType || 'folder'}
              </span>
              {timeAgo && (
                <span className="text-[11px] font-medium">{timeAgo}</span>
              )}
            </div>
            {!screenshot && (
              <div className="mt-2 text-[11px] text-muted-foreground/70">
                No screenshot available
              </div>
            )}
          </div>
        </div>
      </div>
    );

    // Wrap with Link if href provided, otherwise use button with onClick
    if (href) {
      return (
        <Link href={href} className="block">
          {cardContent}
        </Link>
      );
    }

    return (
      <button
        type="button"
        onClick={onClick}
        className="focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
      >
        {cardContent}
      </button>
    );
  }

  // List variant
  const Icon = getFileIcon(file.mimeType);
  const parentFolder = getParentFolder(file.path);
  const fileSize = formatFileSize(file.size);

  const listContent = (
    <div
      className={cn(
        'w-full text-left rounded-lg p-4 transition-colors',
        'bg-muted/30 hover:bg-muted/60',
        className
      )}
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
              {file.name}
            </h3>
          </div>

          {/* Parent folder */}
          {parentFolder && (
            <p className="text-xs text-muted-foreground truncate">
              {parentFolder}
            </p>
          )}

          {/* Summary, snippet, or primary text */}
          {snippet ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {cleanHtmlTags(snippet)}...
            </p>
          ) : summary ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {summary}
            </p>
          ) : primaryText ? (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {primaryText}
            </p>
          ) : null}

          {/* Metadata row */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {/* Tags */}
            {tags && tags.length > 0 && (
              <>
                <span className="truncate max-w-[200px]">
                  {tags.join(', ')}
                </span>
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

            {/* Time */}
            <span>{timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  );

  // Wrap with Link if href provided, otherwise use button with onClick
  if (href) {
    return (
      <Link href={href} className="block">
        {listContent}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
    >
      {listContent}
    </button>
  );
}

/**
 * Text preview component with truncation
 */
function TextPreview({
  text,
  maxChars,
  className,
}: {
  text: string | null;
  maxChars: number;
  className?: string;
}) {
  const display = (text ?? '').trim();

  if (!display) {
    return null;
  }

  const shortened = display.length > maxChars
    ? `${display.slice(0, maxChars).trimEnd()}…`
    : display;

  return (
    <div className={cn('whitespace-pre-wrap break-words', className)}>
      {shortened}
    </div>
  );
}

/**
 * Get file icon based on MIME type
 */
function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;

  if (mimeType.startsWith('text/')) return FileText;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('gz')) {
    return Archive;
  }

  return File;
}

/**
 * Get parent folder from path
 */
function getParentFolder(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  parts.pop(); // Remove filename
  return parts.join('/') + '/';
}

/**
 * Format file size in human-readable format
 */
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

/**
 * Strip HTML tags from string
 */
function cleanHtmlTags(html: string): string {
  return html
    .replace(/<em>/g, '')
    .replace(/<\/em>/g, '')
    .slice(0, 150);
}
