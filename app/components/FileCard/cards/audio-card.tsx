import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2, Volume2, MapPin, CheckCircle2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import { AudioModal } from '../modals/audio-modal';
import { cardContainerClass } from '../ui/card-styles';
import { useSelectionSafe } from '~/contexts/selection-context';
import {
  downloadFile,
  shareFile,
  canShare,
  isIOS,
  togglePin,
  getFileLibraryUrl,
  getFileContentUrl,
} from '../utils';

// Calculate bar width based on duration (in seconds)
// Min: 100px, Max: calc(50% - 40px), scales linearly from 0-60s
function getBarWidth(duration: number): string {
  const minWidth = 100;
  const maxWidthPercent = 50;
  const maxWidthOffset = 40;
  const maxDuration = 60; // Cap at 60 seconds for width calculation

  const cappedDuration = Math.min(duration, maxDuration);
  const ratio = cappedDuration / maxDuration;

  // At 0s: minWidth, at 60s: calc(50% - 40px)
  // Interpolate between them
  if (ratio === 0) return `${minWidth}px`;
  if (ratio >= 1) return `calc(${maxWidthPercent}% - ${maxWidthOffset}px)`;

  // Linear interpolation: we need to go from 100px to calc(50% - 40px)
  // Use clamp to handle this properly
  return `clamp(${minWidth}px, calc(${minWidth}px + (${maxWidthPercent}% - ${maxWidthOffset}px - ${minWidth}px) * ${ratio}), calc(${maxWidthPercent}% - ${maxWidthOffset}px))`;
}

// Format duration as "5"" for 5 seconds
function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) {
    return `${rounded}"`;
  }
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}'${secs.toString().padStart(2, '0')}"`;
}

export function AudioCard({
  file,
  className,
  matchContext,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: BaseCardProps) {
  const navigate = useNavigate();
  const selection = useSelectionSafe();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [seekPreview, setSeekPreview] = useState<number | null>(null); // Preview progress while dragging
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | null>(null);
  const isDragging = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const src = getFileContentUrl(file);
  const href = getFileLibraryUrl(file.path);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleTimeUpdate = () => {
      if (audio.duration) {
        setProgress((audio.currentTime / audio.duration) * 100);
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      // Clean up click timer on unmount
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
      }
    };
  }, []);

  const DRAG_THRESHOLD = 10; // pixels of movement to trigger seek mode

  // Calculate seek ratio from mouse position
  const getSeekRatio = (clientX: number): number => {
    const container = containerRef.current;
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    const clickX = clientX - rect.left;
    return Math.max(0, Math.min(1, clickX / rect.width));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    dragStartX.current = e.clientX;
    isDragging.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragStartX.current === null) return;

    const movement = Math.abs(e.clientX - dragStartX.current);

    if (movement >= DRAG_THRESHOLD) {
      isDragging.current = true;
      // Show preview progress (visual only, no actual seek)
      if (duration) {
        const ratio = getSeekRatio(e.clientX);
        setSeekPreview(ratio * 100);
      }
    }
  };

  const DOUBLE_CLICK_DELAY = 250; // ms - delay before treating as single click

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    setSeekPreview(null); // Clear preview

    if (!audio) {
      dragStartX.current = null;
      return;
    }

    if (isDragging.current && duration) {
      // Was dragging - apply seek on release
      const ratio = getSeekRatio(e.clientX);
      audio.currentTime = ratio * duration;
      // Auto-play after seek
      if (!isPlaying) {
        audio.play();
        setIsPlaying(true);
      }
    } else {
      // Handle click with delayed single-click detection
      if (clickTimer.current) {
        // Second click within delay - it's a double-click
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
        setIsModalOpen(true);
      } else {
        // First click - wait to see if it's a double-click
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null;
          // Single click confirmed - toggle play/pause
          if (isPlaying) {
            audio.pause();
            setIsPlaying(false);
          } else {
            audio.play();
            setIsPlaying(true);
          }
        }, DOUBLE_CLICK_DELAY);
      }
    }

    dragStartX.current = null;
    isDragging.current = false;
  };

  // Use document-level listeners to track mouse outside the element
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (dragStartX.current === null) return;

      const movement = Math.abs(e.clientX - dragStartX.current);

      if (movement >= DRAG_THRESHOLD) {
        isDragging.current = true;
        if (duration) {
          const ratio = getSeekRatio(e.clientX);
          setSeekPreview(ratio * 100);
        }
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (dragStartX.current === null) return;

      const audio = audioRef.current;
      setSeekPreview(null);

      if (audio && isDragging.current && duration) {
        const ratio = getSeekRatio(e.clientX);
        audio.currentTime = ratio * duration;
        if (!isPlaying) {
          audio.play();
          setIsPlaying(true);
        }
      }

      dragStartX.current = null;
      isDragging.current = false;
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [duration, isPlaying]);

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

  const barWidth = duration > 0 ? getBarWidth(duration) : '100px';

  // Show seek preview while dragging, otherwise show actual progress
  const displayProgress = seekPreview !== null ? seekPreview : progress;

  const cardContent = (
    <div
      ref={containerRef}
      className={cn(
        cardContainerClass,
        'cursor-pointer h-10',
        matchContext ? 'w-2/3' : 'min-w-[100px]',
        className
      )}
      style={{ width: matchContext ? undefined : barWidth }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Progress background */}
      <div
        className={cn(
          'absolute inset-0 bg-primary/20',
          seekPreview === null && 'transition-all duration-100'
        )}
        style={{ width: `${displayProgress}%` }}
      />

      {/* Content */}
      <div className="relative h-full flex items-center justify-between px-3 gap-2">
        <Volume2
          className={cn(
            'w-4 h-4 flex-shrink-0 transition-colors',
            isPlaying ? 'text-primary' : 'text-muted-foreground'
          )}
        />
        <span className="text-sm text-muted-foreground">
          {duration > 0 ? formatDuration(duration) : '--"'}
        </span>
      </div>

      {/* Hidden audio element */}
      <audio ref={audioRef} src={src} preload="metadata" />

      {matchContext && <MatchContext context={matchContext} />}
    </div>
  );

  return (
    <>
      <ContextMenuWrapper actions={actions}>
        {cardContent}
      </ContextMenuWrapper>
      <AudioModal
        file={file}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
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
