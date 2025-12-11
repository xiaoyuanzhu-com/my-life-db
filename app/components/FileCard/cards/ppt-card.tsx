import { useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { FallbackModal } from '../modals/fallback-modal';
import {
  downloadFile,
  shareFile,
  canShare,
  togglePin,
  getFileLibraryUrl,
  getScreenshotUrl,
} from '../utils';

export function PptCard({
  file,
  className,
  priority = false,
  matchContext,
}: BaseCardProps) {
  const navigate = useNavigate();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const screenshotSrc = getScreenshotUrl(file);
  const href = getFileLibraryUrl(file.path);

  const handleOpen = () => navigate(href);

  const handleTogglePin = async () => {
    const success = await togglePin(file.path);
    if (success) {
      window.location.reload();
    }
  };

  const handleShare = () => shareFile(file.path, file.name, file.mimeType);

  const actions: ContextMenuAction[] = [
    { icon: ExternalLink, label: 'Open', onClick: handleOpen },
    { icon: Pin, label: file.isPinned ? 'Unpin' : 'Pin', onClick: handleTogglePin },
    { icon: Download, label: 'Save', onClick: () => downloadFile(file.path, file.name) },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Trash2, label: 'Delete', onClick: () => setIsDeleteDialogOpen(true), variant: 'destructive' },
  ];

  const cardContent = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border border-border bg-muted touch-callout-none select-none cursor-pointer',
        'max-w-[calc(100%-40px)] w-fit',
        className
      )}
      onClick={() => setIsPreviewOpen(true)}
    >
      {screenshotSrc ? (
        <div
          className="relative flex items-center justify-center"
          style={{ minWidth: 100, minHeight: 100 }}
        >
          <img
            src={screenshotSrc}
            alt={file.name}
            className="object-contain"
            style={{
              maxWidth: 'min(calc(100vw - 40px), 448px)',
              maxHeight: 320,
              width: 'auto',
              height: 'auto',
            }}
            loading={priority ? 'eager' : 'lazy'}
          />
        </div>
      ) : (
        <div className="p-6 flex items-center justify-center min-h-[120px]">
          <div className="text-center">
            <div className="text-sm font-medium text-foreground/80 break-all">
              {file.name}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              PowerPoint Presentation
            </div>
          </div>
        </div>
      )}
      {matchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions}>
        {cardContent}
      </ContextMenuWrapper>
      <FallbackModal
        file={file}
        open={isPreviewOpen}
        onOpenChange={setIsPreviewOpen}
      />
      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        fileName={file.name}
        filePath={file.path}
      />
    </>
  );
}
