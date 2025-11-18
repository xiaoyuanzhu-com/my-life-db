'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/utils/format-timestamp';
import type { FileWithDigests } from '@/types/file-card';

export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
  showTimestamp?: boolean;
}

/**
 * Content-focused file card component with adaptive sizing
 * Displays text content, images, or filename based on file type
 */
export function FileCard({ file, className, showTimestamp = false }: FileCardProps) {
  // Derive href from file path - navigate to library with ?open parameter
  const href = useMemo(() => {
    return `/library?open=${encodeURIComponent(file.path)}`;
  }, [file.path]);

  // Determine content type and data
  const content = useMemo(() => {
    const isImage = file.mimeType?.startsWith('image/');
    const isVideo = file.mimeType?.startsWith('video/');
    const isAudio = file.mimeType?.startsWith('audio/');

    // Check for screenshot
    const screenshotDigest = file.digests.find(d => d.type === 'screenshot');
    const hasScreenshot = !!screenshotDigest?.sqlarName;

    // Handle video files
    if (isVideo) {
      const src = `/raw/${file.path}`;
      return { type: 'video' as const, src, mimeType: file.mimeType };
    }

    // Handle audio files
    if (isAudio) {
      const src = `/raw/${file.path}`;
      return { type: 'audio' as const, src, mimeType: file.mimeType };
    }

    // Handle images (prefer screenshot for URLs, actual image for files)
    if (isImage || hasScreenshot) {
      // Generate image/screenshot URL
      const pathHash = btoa(file.path)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
        .slice(0, 12);

      const src = hasScreenshot
        ? `/sqlar/${pathHash}/screenshot/screenshot.png`
        : `/raw/${file.path}`;

      return { type: 'image' as const, src, alt: file.name };
    }

    // Show text preview if available
    if (file.textPreview) {
      return { type: 'text' as const, text: file.textPreview };
    }

    // Fallback to filename
    return { type: 'filename' as const, name: file.name };
  }, [file]);

  return (
    <div className={cn('w-full', className)}>
      {/* Timestamp - centered horizontally above card */}
      {showTimestamp && (
        <div className="text-xs text-muted-foreground text-center mb-2">
          {formatTimestamp(file.createdAt)}
        </div>
      )}

      <div className="group relative w-full overflow-hidden rounded-lg border border-border bg-muted">
        {content.type === 'image' ? (
          <div className="relative w-full">
            <Image
              src={content.src}
              alt={content.alt}
              width={800}
              height={600}
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="w-full h-auto object-contain"
              priority={false}
            />
          </div>
      ) : content.type === 'video' ? (
        <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
          <video
            src={content.src}
            controls
            className="w-full h-full object-contain bg-black"
            preload="metadata"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      ) : content.type === 'audio' ? (
        <div className="p-6 flex items-center justify-center min-h-[120px]">
          <div className="w-full">
            <div className="text-sm font-medium text-foreground/80 mb-4 text-center break-all">
              {file.name}
            </div>
            <audio
              src={content.src}
              controls
              className="w-full"
              preload="metadata"
            >
              Your browser does not support the audio tag.
            </audio>
          </div>
        </div>
      ) : content.type === 'text' ? (
        <div className="p-4">
          <div className="prose prose-sm dark:prose-invert max-w-none select-text">
            <TextContent text={content.text} />
          </div>
        </div>
      ) : (
        <div className="p-6 flex items-center justify-center min-h-[120px]">
          <div className="text-center">
            <div className="text-sm font-medium text-foreground/80 break-all">
              {content.name}
            </div>
            {file.mimeType && (
              <div className="mt-2 text-xs text-muted-foreground">
                {file.mimeType}
              </div>
            )}
          </div>
        </div>
      )}

        {/* Hover open button */}
        <Link
          href={href}
          className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-background/90 backdrop-blur-sm border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Open
        </Link>
      </div>
    </div>
  );
}

/**
 * Text content display with line limiting
 */
function TextContent({ text }: { text: string }) {
  const lines = text.split('\n').slice(0, 15); // Max 15 lines
  const displayText = lines.join('\n');
  const truncated = lines.length < text.split('\n').length;

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {displayText}
      {truncated && <span className="text-muted-foreground">...</span>}
    </div>
  );
}
