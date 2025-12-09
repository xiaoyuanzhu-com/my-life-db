import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Copy, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { highlightMatches } from '../ui/text-highlight';
import {
  togglePin,
  fetchFullContent,
  getFileLibraryUrl,
} from '../utils';

const MAX_LINES = 50;

function getTextDisplay(text: string, isExpanded: boolean) {
  const allLines = text.split('\n');
  const shouldTruncate = allLines.length >= MAX_LINES;
  const displayLines = isExpanded ? allLines : allLines.slice(0, MAX_LINES);
  const displayText = displayLines.join('\n');
  return { displayText, shouldTruncate };
}

export function TextCard({
  file,
  className,
  highlightTerms,
  matchContext,
}: BaseCardProps) {
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const href = getFileLibraryUrl(file.path);
  const previewText = file.textPreview || '';

  // Reset copy status when file changes
  useEffect(() => {
    if (copyResetTimeoutRef.current) {
      clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setCopyStatus('idle');
  }, [file.path]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const ensureFullContent = useCallback(async (options?: { silent?: boolean }) => {
    if (fullContent) return fullContent;
    if (!file.textPreview) return null;

    if (!options?.silent) setIsLoading(true);

    const text = await fetchFullContent(file.path);
    if (text) {
      setFullContent(text);
    }

    if (!options?.silent) setIsLoading(false);
    return text || fullContent;
  }, [file.path, file.textPreview, fullContent]);

  const handleOpen = () => navigate(href);

  const handleTogglePin = async () => {
    const success = await togglePin(file.path);
    if (success) {
      window.location.reload();
    }
  };

  const handleCopy = useCallback(async () => {
    if (!navigator.clipboard) {
      console.error('Clipboard API not available');
      return;
    }

    let textToCopy = fullContent || previewText;
    if (!fullContent) {
      const fetched = await ensureFullContent({ silent: true });
      if (fetched) textToCopy = fetched;
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
  }, [ensureFullContent, fullContent, previewText]);

  const handleToggleExpand = useCallback(async () => {
    if (!isExpanded && !fullContent && file.textPreview) {
      const text = await ensureFullContent();
      if (text) setIsExpanded(true);
    } else {
      setIsExpanded(!isExpanded);
    }
  }, [isExpanded, fullContent, file.textPreview, ensureFullContent]);

  const { displayText, shouldTruncate } = getTextDisplay(
    fullContent || previewText,
    isExpanded
  );

  const actions: ContextMenuAction[] = [
    { icon: ExternalLink, label: 'Open', onClick: handleOpen },
    { icon: Pin, label: file.isPinned ? 'Unpin' : 'Pin', onClick: handleTogglePin },
    { icon: Copy, label: copyStatus === 'copied' ? 'Copied' : 'Copy', onClick: handleCopy },
    {
      icon: isExpanded ? ChevronUp : ChevronDown,
      label: isLoading ? 'Loading...' : isExpanded ? 'Collapse' : 'Expand',
      onClick: handleToggleExpand,
      disabled: isLoading,
      hidden: !shouldTruncate,
    },
    { icon: Trash2, label: 'Delete', onClick: () => setIsDeleteDialogOpen(true), variant: 'destructive' },
  ];

  const cardContent = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border border-border bg-muted touch-callout-none',
        'max-w-[calc(100%-40px)] w-fit',
        className
      )}
    >
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
      {matchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions} selectTextOnOpen>
        {cardContent}
      </ContextMenuWrapper>
      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        fileName={file.name}
        filePath={file.path}
      />
    </>
  );
}
