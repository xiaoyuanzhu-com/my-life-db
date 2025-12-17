import { useState, useCallback, useEffect } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { downloadFile, shareFile, canShare, isIOS } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';
import { ModalLayout, useModalLayout, getModalContainerStyles } from '../ui/modal-layout';

type ModalView = 'content' | 'digests';

export function FallbackModal({ file, open, onOpenChange }: BaseModalProps) {
  const [activeView, setActiveView] = useState<ModalView>('content');
  const layout = useModalLayout();

  // Reset view when modal opens
  useEffect(() => {
    if (open) {
      setActiveView('content');
    }
  }, [open]);

  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    shareFile(file.path, file.name, file.mimeType);
  }, [file.path, file.name, file.mimeType]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => (prev === 'digests' ? 'content' : 'digests'));
  }, []);

  const handleCloseDigests = useCallback(() => {
    setActiveView('content');
  }, []);

  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';
  const containerStyles = getModalContainerStyles(layout, showDigests);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 border-none rounded-none shadow-none !bg-transparent outline-none overflow-hidden"
        style={containerStyles}
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />
        <ModalLayout
          showDigests={showDigests}
          onCloseDigests={handleCloseDigests}
          digestsContent={<DigestsPanel file={file} />}
          contentClassName="flex flex-col items-center justify-center"
        >
          <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
            <div className="text-center space-y-2 text-sm px-6">
              <div className="break-all">{file.name}</div>
              {file.size !== null && (
                <div className="text-muted-foreground">{formatFileSize(file.size)}</div>
              )}
              <div className="text-muted-foreground">
                {new Date(file.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
        </ModalLayout>
      </DialogContent>
    </Dialog>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
