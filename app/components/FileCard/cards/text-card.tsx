import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Copy, Trash2, MapPin, CheckCircle2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { cardContainerClass } from '../ui/card-styles';
import { TextModal } from '../modals/text-modal';
import { highlightMatches } from '../ui/text-highlight';
import { useSelectionSafe } from '~/contexts/selection-context';
import {
  togglePin,
  getFileLibraryUrl,
} from '../utils';

const MAX_LINES = 20;

function getTextDisplay(text: string) {
  const allLines = text.split('\n');
  const shouldTruncate = allLines.length > MAX_LINES;
  const displayLines = allLines.slice(0, MAX_LINES);
  const displayText = displayLines.join('\n');
  return { displayText, shouldTruncate };
}

export function TextCard({
  file,
  className,
  highlightTerms,
  matchContext,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: BaseCardProps) {
  const navigate = useNavigate();
  const selection = useSelectionSafe();
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
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

    const textToCopy = fullContent || previewText;
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
  }, [fullContent, previewText]);

  const handleDoubleClick = () => {
    setIsModalOpen(true);
  };

  const handleFullContentLoaded = useCallback((content: string) => {
    setFullContent(content);
  }, []);

  const { displayText, shouldTruncate } = getTextDisplay(previewText);

  const actions: ContextMenuAction[] = [
    { icon: ExternalLink, label: 'Open', onClick: handleOpen },
    { icon: MapPin, label: 'Locate', onClick: () => onLocateInFeed?.(), hidden: !onLocateInFeed },
    { icon: CheckCircle2, label: 'Select', onClick: () => selection?.enterSelectionMode(file.path), hidden: !selection },
    { icon: Pin, label: file.isPinned ? 'Unpin' : 'Pin', onClick: handleTogglePin },
    { icon: Copy, label: copyStatus === 'copied' ? 'Copied' : 'Copy', onClick: handleCopy },
    { icon: Trash2, label: 'Delete', onClick: () => setIsDeleteDialogOpen(true), variant: 'destructive' },
  ];

  const cardContent = (
    <div
      className={cn(
        cardContainerClass,
        matchContext ? 'w-2/3' : 'max-w-[calc(100%-40px)] w-fit',
        className
      )}
      onDoubleClick={handleDoubleClick}
    >
      <div className="relative mx-auto">
        <div className="p-4 max-w-full">
          <div className="prose prose-sm dark:prose-invert max-w-none select-text">
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed font-content">
              {highlightTerms && highlightTerms.length > 0
                ? highlightMatches(displayText, highlightTerms)
                : displayText}
              {shouldTruncate && <span className="text-muted-foreground">...</span>}
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
        onDeleted={onDeleted}
        onRestoreItem={onRestoreItem}
      />
      <TextModal
        file={file}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        previewText={previewText}
        fullContent={fullContent}
        onFullContentLoaded={handleFullContentLoaded}
      />
    </>
  );
}
