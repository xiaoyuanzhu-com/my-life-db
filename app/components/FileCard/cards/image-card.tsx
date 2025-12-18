import { useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2, MapPin, CheckCircle2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { cardContainerClass } from '../ui/card-styles';
import { useSelectionSafe } from '~/contexts/selection-context';
import { useCardModal } from '../ui/use-modal-navigation';
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
  const openModal = useCardModal(file);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

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
        onClick={openModal}
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
