import { useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2, MapPin, CheckCircle2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { cardContainerClass } from '../ui/card-styles';
import { ImageModal } from '../modals/image-modal';
import { useSelectionSafe } from '~/contexts/selection-context';
import { useModalNavigationSafe } from '~/contexts/modal-navigation-context';
import {
  downloadFile,
  shareFile,
  canShare,
  isIOS,
  togglePin,
  getFileLibraryUrl,
  getFileContentUrl,
} from '../utils';

export function ImageCard({
  file,
  className,
  priority = false,
  matchContext,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: BaseCardProps) {
  const navigate = useNavigate();
  const selection = useSelectionSafe();
  const navigation = useModalNavigationSafe();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

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

  const src = getFileContentUrl(file);
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

  const cardContent = (
    <div
      className={cn(
        cardContainerClass,
        matchContext ? 'w-2/3' : 'max-w-[calc(100%-40px)] w-fit',
        className
      )}
    >
      <div
        className="relative flex items-center justify-center cursor-pointer mx-auto"
        style={{ minWidth: 100, minHeight: 100 }}
        onClick={handleOpenModal}
      >
        <img
          src={src}
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
      {matchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions}>
        {cardContent}
      </ContextMenuWrapper>
      <ImageModal
        file={file}
        open={modalOpen}
        onOpenChange={handleCloseModal}
        hasPrev={navigation?.hasPrev}
        hasNext={navigation?.hasNext}
        onPrev={navigation?.goToPrev}
        onNext={navigation?.goToNext}
      />
      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        fileName={file.name}
        filePath={file.path}
        onDeleted={onDeleted}
        onRestoreItem={onRestoreItem}
      />
    </>
  );
}
