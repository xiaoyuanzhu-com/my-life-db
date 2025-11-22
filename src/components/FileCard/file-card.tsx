'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/utils/format-timestamp';
import type { FileWithDigests } from '@/types/file-card';
import type { SearchResultItem } from '@/app/api/search/route';

export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
  showTimestamp?: boolean;
  highlightTerms?: string[];
  matchContext?: SearchResultItem['matchContext'];
}

/**
 * Content-focused file card component with adaptive sizing
 * Displays text content, images, or filename based on file type
 */
export function FileCard({
  file,
  className,
  showTimestamp = false,
  highlightTerms,
  matchContext,
}: FileCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Derive href from file path - navigate to library with ?open parameter
  const href = useMemo(() => {
    return `/library?open=${encodeURIComponent(file.path)}`;
  }, [file.path]);

  // Handle expand: fetch full content from raw API
  const handleToggleExpand = async () => {
    if (!isExpanded && !fullContent && file.textPreview) {
      // Expanding for the first time - fetch full content
      setIsLoading(true);
      try {
        const response = await fetch(`/raw/${file.path}`);
        if (response.ok) {
          const text = await response.text();
          setFullContent(text);
          setIsExpanded(true);
        }
      } catch (error) {
        console.error('Failed to load full content:', error);
      } finally {
        setIsLoading(false);
      }
    } else {
      // Just toggle collapsed/expanded
      setIsExpanded(!isExpanded);
    }
  };

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
  const textDisplay = content.type === 'text'
    ? getTextDisplay(fullContent || content.text, isExpanded)
    : { displayText: '', shouldTruncate: false };

  return (
    <div className={cn('w-full flex flex-col items-end', className)}>
      {/* Timestamp - centered horizontally above card */}
      {showTimestamp && (
        <div className="text-xs text-muted-foreground mb-2 mr-5">
          {formatTimestamp(file.createdAt)}
        </div>
      )}

      <div className="group relative max-w-[calc(100%-40px)] w-fit overflow-hidden rounded-lg border border-border bg-muted">
        <div className="relative">
          {content.type === 'image' ? (
            <div className="relative w-full max-w-md">
              <Image
                src={content.src}
                alt={content.alt}
                width={800}
                height={600}
                sizes="(max-width: 768px) calc(100vw - 40px), 448px"
                className="w-full h-auto object-contain"
                priority={false}
              />
            </div>
          ) : content.type === 'video' ? (
            <div className="relative w-full max-w-md" style={{ aspectRatio: '16/9' }}>
              <video
                controls
                playsInline
                className="w-full h-full object-contain bg-black"
                preload="metadata"
                muted
              >
                <source src={content.src} type={content.mimeType || 'video/mp4'} />
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
            <TextContent
              displayText={textDisplay.displayText}
              highlightTerms={highlightTerms}
              isExpanded={isExpanded}
              shouldTruncate={textDisplay.shouldTruncate}
            />
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

          {/* Hover action bar */}
          <div className="pointer-events-none absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <div className="flex items-center gap-2 pointer-events-auto">
              {textDisplay.shouldTruncate && (
                <button
                  onClick={handleToggleExpand}
                  disabled={isLoading}
                  className="bg-background/90 backdrop-blur-sm border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-wait"
                >
                  {isLoading ? 'Loading...' : isExpanded ? 'Collapse' : 'Expand'}
                </button>
              )}
              <Link
                href={href}
                className="bg-background/90 backdrop-blur-sm border border-border rounded-md px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Open
              </Link>
            </div>
          </div>
        </div>

        {matchContext && (
          <MatchContext context={matchContext} />
        )}
      </div>
    </div>
  );
}

/**
 * Text content display with optional term highlighting and line limiting
 */
function TextContent({
  displayText,
  highlightTerms,
  isExpanded,
  shouldTruncate,
}: {
  displayText: string;
  highlightTerms?: string[];
  isExpanded: boolean;
  shouldTruncate: boolean;
}) {
  return (
    <div className="relative">
      <div className="p-4 max-w-full">
        <div className="prose prose-sm dark:prose-invert max-w-none select-text">
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {highlightTerms && highlightTerms.length > 0
              ? highlightMatches(displayText, highlightTerms)
              : displayText}
            {shouldTruncate && !isExpanded && <span className="text-muted-foreground">...</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function getTextDisplay(text: string, isExpanded: boolean) {
  const allLines = text.split('\n');
  const maxLines = 50;
  const shouldTruncate = allLines.length > maxLines;
  const displayLines = isExpanded ? allLines : allLines.slice(0, maxLines);
  const displayText = displayLines.join('\n');

  return { displayText, shouldTruncate };
}

function highlightMatches(text: string, terms: string[]) {
  const escapedTerms = Array.from(new Set(
    terms
      .map(term => term.trim())
      .filter(term => term.length > 0)
      .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  ));

  if (escapedTerms.length === 0) {
    return text;
  }

  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const parts = text.split(regex);

  return parts.map((part, index) => {
    const isMatch = index % 2 === 1;
    if (!isMatch) {
      return <span key={`text-${index}`}>{part}</span>;
    }

    return (
      <mark
        key={`match-${index}`}
        className="rounded-sm bg-yellow-300/90 px-0.5 py-0 text-slate-900 ring-1 ring-yellow-400 dark:bg-yellow-200/95 dark:text-slate-900 dark:ring-yellow-300"
      >
        {part}
      </mark>
    );
  });
}

type MatchContextProps = {
  context: NonNullable<SearchResultItem['matchContext']>;
};

function MatchContext({ context }: MatchContextProps) {
  // Handle semantic match context
  if (context.source === 'semantic') {
    const scorePercent = context.score ? Math.round(context.score * 100) : null;
    return (
      <div className="border-t border-border bg-background/80 px-4 py-3 text-xs text-foreground/80">
        <p className="mb-1 font-semibold text-muted-foreground">
          Semantic match{scorePercent !== null ? ` (${scorePercent}% similar)` : ''}
          {context.sourceType && ` · ${context.sourceType}`}
        </p>
        <div className="text-xs text-foreground leading-relaxed italic">
          {context.snippet}
        </div>
      </div>
    );
  }

  // Handle digest match context (keyword)
  // Snippet may contain <em> tags from Meilisearch (for fuzzy matches)
  const snippetWithHighlights = renderHighlightedSnippet(context.snippet);

  return (
    <div className="border-t border-border bg-background/80 px-4 py-3 text-xs text-foreground/80">
      <p className="mb-1 font-semibold text-muted-foreground">
        Matched {context.digest?.label ?? 'digest'}
      </p>
      <div className="text-xs text-foreground leading-relaxed">
        {snippetWithHighlights}
      </div>
    </div>
  );
}

/**
 * Render a snippet with <em> tags from Meilisearch as React mark elements.
 * Handles fuzzy match highlights like "docube" → "<em>Docume</em>ntation"
 */
function renderHighlightedSnippet(snippet: string) {
  // Split by <em> and </em> tags
  const parts = snippet.split(/(<em>|<\/em>)/);
  const elements: React.ReactNode[] = [];
  let isHighlight = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === '<em>') {
      isHighlight = true;
    } else if (part === '</em>') {
      isHighlight = false;
    } else if (part) {
      if (isHighlight) {
        elements.push(
          <mark
            key={`match-${i}`}
            className="rounded-sm bg-yellow-300/90 px-0.5 py-0 text-slate-900 ring-1 ring-yellow-400 dark:bg-yellow-200/95 dark:text-slate-900 dark:ring-yellow-300"
          >
            {part}
          </mark>
        );
      } else {
        elements.push(<span key={`text-${i}`}>{part}</span>);
      }
    }
  }

  return <>{elements}</>;
}
