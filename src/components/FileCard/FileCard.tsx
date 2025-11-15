'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { FileWithDigests } from '@/types/file-card';

export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
}

/**
 * Content-focused file card component with adaptive sizing
 * Displays text content, images, or filename based on file type
 */
export function FileCard({ file, className }: FileCardProps) {
  // Derive href from file path - navigate to library with ?open parameter
  const href = useMemo(() => {
    return `/library?open=${encodeURIComponent(file.path)}`;
  }, [file.path]);

  // Determine content type and data
  const content = useMemo(() => {
    const isImage = file.mimeType?.startsWith('image/');
    const isVideo = file.mimeType?.startsWith('video/');
    const isAudio = file.mimeType?.startsWith('audio/');
    const isText = file.mimeType?.startsWith('text/') ||
                   file.mimeType === 'application/json' ||
                   file.mimeType === 'application/javascript';

    // Check for primary text (user's original input)
    const primaryTextDigest = file.digests.find(d => d.type === 'primary-text');
    const primaryText = primaryTextDigest?.content;

    // Check for screenshot
    const screenshotDigest = file.digests.find(d => d.type === 'screenshot');
    const hasScreenshot = !!screenshotDigest?.sqlarName;

    // Get content-md digest for text files
    const contentMdDigest = file.digests.find(d => d.type === 'content-md');
    const contentMd = contentMdDigest?.content;

    // Handle video files
    if (isVideo) {
      const src = `/api/files/content?path=${encodeURIComponent(file.path)}`;
      return { type: 'video' as const, src, mimeType: file.mimeType };
    }

    // Handle audio files
    if (isAudio) {
      const src = `/api/files/content?path=${encodeURIComponent(file.path)}`;
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
        ? `/api/inbox/sqlar/${pathHash}/screenshot/screenshot.png`
        : `/api/files/content?path=${encodeURIComponent(file.path)}`;

      return { type: 'image' as const, src, alt: file.name };
    }

    if (primaryText) {
      return { type: 'text' as const, text: primaryText };
    }

    if (isText && contentMd) {
      return { type: 'text' as const, text: contentMd };
    }

    // Fallback to filename
    return { type: 'filename' as const, name: file.name };
  }, [file]);

  return (
    <Link href={href} className="block">
      <div
        className={cn(
          'group relative w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-all duration-200',
          'hover:shadow-md hover:border-foreground/20',
          className
        )}
      >
        {content.type === 'image' ? (
          <div className="relative w-full" style={{ aspectRatio: '4/3' }}>
            <Image
              src={content.src}
              alt={content.alt}
              fill
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="object-cover"
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
            <div className="prose prose-sm dark:prose-invert max-w-none">
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
      </div>
    </Link>
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
