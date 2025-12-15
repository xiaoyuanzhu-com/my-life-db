import { useState, useCallback } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { getRawFileUrl, downloadFile, shareFile, canShare } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';

type ModalView = 'content' | 'digests';

export function ImageModal({ file, open, onOpenChange }: BaseModalProps) {
  const [activeView, setActiveView] = useState<ModalView>('content');
  const src = getRawFileUrl(file.path);

  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    shareFile(file.path, file.name, file.mimeType);
  }, [file.path, file.name, file.mimeType]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => (prev === 'digests' ? 'content' : 'digests'));
  }, []);

  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-h-[90vh] p-0 border-none rounded-none shadow-none bg-transparent outline-none overflow-hidden ${
          showDigests ? 'max-w-[90vw] w-full flex' : 'max-w-[90vw] sm:max-w-[90vw] w-fit'
        }`}
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />
        <div
          className={`relative flex items-center justify-center cursor-pointer ${
            showDigests ? 'w-1/2' : ''
          }`}
          onClick={() => !showDigests && onOpenChange(false)}
        >
          <img
            src={src}
            alt={file.name}
            className="object-contain"
            style={{
              maxWidth: showDigests ? '45vw' : '90vw',
              maxHeight: '90vh',
              width: 'auto',
              height: 'auto',
            }}
          />
        </div>
        {showDigests && (
          <div className="w-1/2 h-[90vh] bg-background border-l border-border rounded-r-lg">
            <DigestsPanel file={file} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
