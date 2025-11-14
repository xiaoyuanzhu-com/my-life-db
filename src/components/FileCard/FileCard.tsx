'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import type { FileWithDigests } from '@/types/file-card';

export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
  highlight?: string;        // Optional highlight text (TODO: implement highlight UI per type)
}

/**
 * Unified file card component
 * Used by both inbox and search results
 */
export function FileCard({
  file,
  className,
  highlight,
}: FileCardProps) {
  // Derive href from file path - navigate to library with ?open parameter
  const href = useMemo(() => {
    return `/library?open=${encodeURIComponent(file.path)}`;
  }, [file.path]);

  // Compute primary text from digests
  const primaryText = useMemo(() => {
    // Look for primary-text digest (user's original input)
    const primaryTextDigest = file.digests.find(d => d.type === 'primary-text');
    return primaryTextDigest?.content || null;
  }, [file.digests]);

  // Compute summary from digests
  const summary = useMemo(() => {
    const summaryDigest = file.digests.find(d => d.type === 'summary');
    return summaryDigest?.content || null;
  }, [file.digests]);

  // Compute screenshot from digests
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

  // Determine display content priority:
  // 1. highlight (if provided)
  // 2. primaryText (user's original input)
  // 3. summary (AI-generated)
  // 4. file.name (fallback)
  const displayContent = useMemo(() => {
    // TODO: Implement highlight UI per type
    if (highlight) {
      return { text: highlight, type: 'highlight' as const };
    }
    if (primaryText) {
      return { text: primaryText, type: 'primary' as const };
    }
    if (summary) {
      return { text: summary, type: 'summary' as const };
    }
    return { text: file.name, type: 'filename' as const };
  }, [highlight, primaryText, summary, file.name]);

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
          {/* Display content based on priority */}
          {displayContent.type === 'primary' || displayContent.type === 'highlight' ? (
            <TextPreview
              text={displayContent.text}
              maxChars={220}
              className="text-base font-medium leading-7 text-foreground drop-shadow-[0_4px_18px_rgba(15,23,42,0.4)]"
            />
          ) : displayContent.type === 'summary' ? (
            <TextPreview
              text={displayContent.text}
              maxChars={220}
              className="text-sm leading-6 text-foreground/90"
            />
          ) : (
            <div className="text-sm text-muted-foreground/70 italic">
              {displayContent.text}
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

  return (
    <Link href={href} className="block">
      {cardContent}
    </Link>
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
