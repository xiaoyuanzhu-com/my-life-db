'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/utils/format-timestamp';
import type { FileWithDigests } from '@/types/file-card';
import type { SearchResultItem } from '@/app/api/search/route';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Copy, Download, ExternalLink, Share2, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export interface FileCardProps {
  file: FileWithDigests;
  className?: string;
  showTimestamp?: boolean;
  highlightTerms?: string[];
  matchContext?: SearchResultItem['matchContext'];
  priority?: boolean;
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
  priority = false,
}: FileCardProps) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive href from file path - navigate to library with ?open parameter
  const href = useMemo(() => {
    return `/library?open=${encodeURIComponent(file.path)}`;
  }, [file.path]);

  const ensureFullContent = useCallback(async (options?: { silent?: boolean }) => {
    if (fullContent) {
      return fullContent;
    }

    if (!file.textPreview) {
      return null;
    }

    if (!options?.silent) {
      setIsLoading(true);
    }

    try {
      const response = await fetch(`/raw/${file.path}`);
      if (response.ok) {
        const text = await response.text();
        setFullContent(text);
        return text;
      }
    } catch (error) {
      console.error('Failed to load full content:', error);
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }

    return fullContent;
  }, [file.path, file.textPreview, fullContent]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (copyResetTimeoutRef.current) {
      clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setCopyStatus('idle');
  }, [file.path]);

  // Handle expand: fetch full content from raw API
  const handleToggleExpand = async () => {
    if (!isExpanded && !fullContent && file.textPreview) {
      const text = await ensureFullContent();
      if (text) {
        setIsExpanded(true);
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

    // Handle images - always use raw file
    if (isImage) {
      const src = `/raw/${file.path}`;
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
  const isTextContent = content.type === 'text';
  const previewText = isTextContent ? content.text : '';

  // Determine file type flags early for use in callbacks
  const isImage = content.type === 'image';
  const isVideo = content.type === 'video';
  const isAudio = content.type === 'audio';
  const isMediaFile = isImage || isVideo || isAudio;

  const handleDownload = useCallback(() => {
    const link = document.createElement('a');
    link.href = `/raw/${file.path}`;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [file.name, file.path]);

  const handleCopy = useCallback(async () => {
    if (!isTextContent) return;
    if (!navigator.clipboard) {
      console.error('Clipboard API not available');
      return;
    }

    let textToCopy = fullContent || previewText;

    if (!fullContent) {
      const fetched = await ensureFullContent({ silent: true });
      if (fetched) {
        textToCopy = fetched;
      }
    }

    if (!textToCopy) return;

    if (copyResetTimeoutRef.current) {
      clearTimeout(copyResetTimeoutRef.current);
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopyStatus('copied');
      copyResetTimeoutRef.current = setTimeout(() => setCopyStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to copy content:', error);
      setCopyStatus('idle');
    }
  }, [ensureFullContent, fullContent, isTextContent, previewText]);

  const handleShare = useCallback(async () => {
    // Check if Web Share API is supported
    if (!navigator.share) {
      console.error('Web Share API not supported');
      return;
    }

    try {
      const shareData: ShareData = {
        title: file.name,
      };

      // For text content, include the text in the share
      if (isTextContent) {
        const textToShare = fullContent || previewText;
        if (textToShare) {
          shareData.text = textToShare;
        }
      } else if (isMediaFile) {
        // For media files (images, videos, audio), share the actual file
        try {
          const response = await fetch(`/raw/${file.path}`);
          if (response.ok) {
            const blob = await response.blob();
            const fileToShare = new File([blob], file.name, { type: file.mimeType || blob.type });

            // Check if files can be shared
            if (navigator.canShare && navigator.canShare({ files: [fileToShare] })) {
              shareData.files = [fileToShare];
            } else {
              // Fallback to URL if file sharing not supported
              shareData.url = `/raw/${file.path}`;
            }
          } else {
            // Fallback to URL if fetch fails
            shareData.url = `/raw/${file.path}`;
          }
        } catch (fetchError) {
          console.error('Failed to fetch file for sharing:', fetchError);
          // Fallback to URL
          shareData.url = `/raw/${file.path}`;
        }
      } else {
        // For other file types, share URL
        shareData.url = `/raw/${file.path}`;
      }

      await navigator.share(shareData);
    } catch (error) {
      // User cancelled or error occurred
      if ((error as Error).name !== 'AbortError') {
        console.error('Failed to share:', error);
      }
    }
  }, [file.name, file.path, file.mimeType, fullContent, isTextContent, previewText, isMediaFile]);

  const handleDeleteClick = useCallback(() => {
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    setIsDeleteDialogOpen(false);

    try {
      const response = await fetch(`/api/library/file?path=${encodeURIComponent(file.path)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete file');
      }

      // Refresh the page or navigate back
      router.refresh();
    } catch (error) {
      console.error('Failed to delete file:', error);
      alert('Failed to delete file. Please try again.');
    }
  }, [file.path, router]);

  const handleOpen = useCallback(() => {
    router.push(href);
  }, [href, router]);

  // Determine if we can share this file
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  return (
    <div className={cn('w-full flex flex-col items-end', className)}>
      {/* Timestamp - centered horizontally above card */}
      {showTimestamp && (
        <div className="text-xs text-muted-foreground mb-2 mr-5">
          {formatTimestamp(file.createdAt)}
        </div>
      )}

      <ContextMenu>
        <ContextMenuTrigger asChild>
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
                    priority={priority}
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

            </div>

            {matchContext && (
              <MatchContext context={matchContext} />
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleOpen}>
            <ExternalLink className="mr-2" />
            Open
          </ContextMenuItem>

          {isTextContent && (
            <>
              <ContextMenuItem onClick={handleCopy}>
                <Copy className="mr-2" />
                {copyStatus === 'copied' ? 'Copied' : 'Copy'}
              </ContextMenuItem>

              {textDisplay.shouldTruncate && (
                <ContextMenuItem onClick={handleToggleExpand} disabled={isLoading}>
                  {isExpanded ? <ChevronUp className="mr-2" /> : <ChevronDown className="mr-2" />}
                  {isLoading ? 'Loading...' : isExpanded ? 'Collapse' : 'Expand'}
                </ContextMenuItem>
              )}
            </>
          )}

          {isMediaFile && (
            <>
              <ContextMenuItem onClick={handleDownload}>
                <Download className="mr-2" />
                Download
              </ContextMenuItem>

              {canShare && (
                <ContextMenuItem onClick={handleShare}>
                  <Share2 className="mr-2" />
                  Share
                </ContextMenuItem>
              )}
            </>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={handleDeleteClick} variant="destructive">
            <Trash2 className="mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {file.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the file and all related data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  // If we have exactly maxLines, assume the preview was truncated
  const shouldTruncate = allLines.length >= maxLines;
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
