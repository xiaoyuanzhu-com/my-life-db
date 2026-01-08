import { useState, useRef, useEffect, useCallback } from 'react';
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
import {
  prepareHighlightState,
  renderHighlightFrame,
  ANIMATION_DURATION,
  type AnimatedHighlightState,
} from '../ui/animated-highlight';

export function ImageCard({
  file,
  className,
  priority = false,
  matchContext,
  matchedObject,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: BaseCardProps) {
  const navigate = useNavigate();
  const selection = useSelectionSafe();
  const openModal = useCardModal(file);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

  const src = getFileContentUrl(file);
  const href = getFileLibraryUrl(file.path);

  // Track image dimensions when loaded
  const handleImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImageDimensions({
        width: imgRef.current.clientWidth,
        height: imgRef.current.clientHeight,
      });
    }
  }, []);

  // Re-measure on resize
  useEffect(() => {
    const handleResize = () => {
      if (imgRef.current) {
        setImageDimensions({
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Animate highlight with SAM3-style glowing effect
  useEffect(() => {
    if (!canvasRef.current || !imageDimensions || !matchedObject) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    // Clear the canvas
    canvas.width = imageDimensions.width;
    canvas.height = imageDimensions.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Prepare the highlight state (expensive computation done once)
    const highlightRegion = {
      bbox: matchedObject.bbox,
      rle: matchedObject.rle,
    };
    const state: AnimatedHighlightState = prepareHighlightState(
      highlightRegion,
      imageDimensions.width,
      imageDimensions.height
    );

    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;

      renderHighlightFrame(
        canvas,
        state,
        imageDimensions.width,
        imageDimensions.height,
        elapsed
      );

      // Keep animating until animation completes, then render one final frame
      if (elapsed < ANIMATION_DURATION) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        // Render final resting state
        renderHighlightFrame(
          canvas,
          state,
          imageDimensions.width,
          imageDimensions.height,
          ANIMATION_DURATION + 1000 // Ensure we're past animation
        );
        animationRef.current = null;
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [matchedObject, imageDimensions]);

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
        matchContext || matchedObject ? 'w-2/3' : 'max-w-[calc(100%-40px)] w-fit',
        className
      )}
    >
      <div
        className="relative flex items-center justify-center cursor-pointer mx-auto"
        style={{ minWidth: 100, minHeight: 100 }}
        onClick={openModal}
      >
        <div className="relative">
          <img
            ref={imgRef}
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
            onLoad={handleImageLoad}
          />
          {/* Animated highlight overlay (rendered to canvas with glowing animation) */}
          {matchedObject && imageDimensions && (
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 pointer-events-none"
              style={{
                width: imageDimensions.width,
                height: imageDimensions.height,
              }}
            />
          )}
        </div>
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
