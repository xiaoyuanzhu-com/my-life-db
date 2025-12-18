import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2, MapPin, CheckCircle2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { cardClickableClass } from '../ui/card-styles';
import { highlightMatches } from '../ui/text-highlight';
import { useSelectionSafe } from '~/contexts/selection-context';
import { useModalNavigationSafe } from '~/contexts/modal-navigation-context';
import {
  downloadFile,
  shareFile,
  canShare,
  isIOS,
  togglePin,
  getFileLibraryUrl,
  getScreenshotUrl,
  formatFileSize,
  truncateMiddle,
} from '../utils';

const EpubModal = lazy(() =>
  import('../modals/epub-modal').then((m) => ({ default: m.EpubModal }))
);

export function EpubCard({
  file,
  className,
  priority = false,
  highlightTerms,
  matchContext,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: BaseCardProps) {
  const navigate = useNavigate();
  const selection = useSelectionSafe();
  const navigation = useModalNavigationSafe();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  // Use navigation context when available
  const modalOpen = navigation ? navigation.isOpen && navigation.currentFile?.path === file.path : isPreviewOpen;
  const handleOpenModal = () => {
    if (navigation) {
      navigation.openModal(file);
    } else {
      setIsPreviewOpen(true);
    }
  };
  const handleCloseModal = (open: boolean) => {
    if (navigation && !open) {
      navigation.closeModal();
    } else {
      setIsPreviewOpen(open);
    }
  };

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
    { icon: MapPin, label: 'Locate', onClick: () => onLocateInFeed?.(), hidden: !onLocateInFeed },
    { icon: CheckCircle2, label: 'Select', onClick: () => selection?.enterSelectionMode(file.path), hidden: !selection },
    { icon: Pin, label: file.isPinned ? 'Unpin' : 'Pin', onClick: handleTogglePin },
    { icon: Download, label: 'Save', onClick: () => downloadFile(file.path, file.name), hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Trash2, label: 'Delete', onClick: () => setIsDeleteDialogOpen(true), variant: 'destructive' },
  ];

  // Check if MatchContext will be shown
  const showMatchContext = matchContext && matchContext.digest?.type !== 'filePath';

  const cardContent = (
    <div
      className={cn(cardClickableClass, showMatchContext ? 'w-2/3' : '', className)}
      onClick={handleOpenModal}
    >
      {screenshotSrc ? (
        <div className="flex flex-col w-[226px] mx-auto">
          <img
            src={screenshotSrc}
            alt={file.name}
            className="w-full h-auto max-h-[320px] object-cover object-top"
            loading={priority ? 'eager' : 'lazy'}
          />
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border flex items-center justify-between">
            <span>
              {highlightTerms?.length
                ? highlightMatches(truncateMiddle(file.name), highlightTerms)
                : truncateMiddle(file.name)}
            </span>
            {file.size != null && (
              <span>{formatFileSize(file.size)}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col w-[226px] mx-auto">
          <div className="p-6 flex items-center justify-center min-h-[120px]">
            <div className="text-center">
              <div className="text-sm font-medium text-foreground/80 break-all">
                {highlightTerms?.length
                  ? highlightMatches(file.name, highlightTerms)
                  : file.name}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                EPUB eBook
              </div>
            </div>
          </div>
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border flex items-center justify-between">
            <span>
              {highlightTerms?.length
                ? highlightMatches(truncateMiddle(file.name), highlightTerms)
                : truncateMiddle(file.name)}
            </span>
            {file.size != null && (
              <span>{formatFileSize(file.size)}</span>
            )}
          </div>
        </div>
      )}
      {/* Skip showing match context for file path matches since filename is visible on card */}
      {showMatchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions}>
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
      {modalOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
              Loading...
            </div>
          }
        >
          <EpubModal
            file={file}
            open={modalOpen}
            onOpenChange={handleCloseModal}
            hasPrev={navigation?.hasPrev}
            hasNext={navigation?.hasNext}
            onPrev={navigation?.goToPrev}
            onNext={navigation?.goToNext}
          />
        </Suspense>
      )}
    </>
  );
}
