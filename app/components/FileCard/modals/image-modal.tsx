import { useState, useCallback, useEffect, useRef } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { getFileContentUrl, downloadFile, shareFile, canShare, isIOS } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';
import { ModalLayout, useModalLayout, getModalContainerStyles } from '../ui/modal-layout';
import type { BoundingBox } from '../ui/digest-renderers';

type ModalView = 'content' | 'digests';

export function ImageModal({ file, open, onOpenChange, hasPrev, hasNext, onPrev, onNext }: BaseModalProps) {
  const [activeView, setActiveView] = useState<ModalView>('content');
  const [highlightedBox, setHighlightedBox] = useState<BoundingBox | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layout = useModalLayout();
  const src = getFileContentUrl(file);

  // Reset view and highlighted box when modal opens
  useEffect(() => {
    if (open) {
      setActiveView('content');
      setHighlightedBox(null);
    }
  }, [open]);

  // Clear highlight after animation (3 seconds)
  useEffect(() => {
    if (highlightedBox) {
      const timer = setTimeout(() => setHighlightedBox(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [highlightedBox]);

  const handleHighlightBoundingBox = useCallback((box: BoundingBox | null) => {
    console.log('Highlighting bounding box:', box);
    setHighlightedBox(box);
  }, []);

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
          digestsContent={<DigestsPanel file={file} imageObjectsSync={{ onHighlightBoundingBox: handleHighlightBoundingBox }} />}
          contentClassName="flex items-center justify-center cursor-pointer"
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={onPrev}
          onNext={onNext}
        >
          <div
            ref={containerRef}
            className="w-full h-full flex items-center justify-center"
            onClick={() => !showDigests && onOpenChange(false)}
          >
            <div className="rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] p-4 relative">
              <img
                ref={imageRef}
                src={src}
                alt={file.name}
                className="object-contain block rounded"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  width: 'auto',
                  height: 'auto',
                }}
              />
              {/* Bounding box overlay - positioned relative to image */}
              {highlightedBox && (
                <div
                  className="absolute pointer-events-none animate-pulse-glow"
                  style={{
                    left: `calc(1rem + ${highlightedBox.x * 100}%)`,
                    top: `calc(1rem + ${highlightedBox.y * 100}%)`,
                    width: `${highlightedBox.width * 100}%`,
                    height: `${highlightedBox.height * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        </ModalLayout>
      </DialogContent>
    </Dialog>
  );
}
