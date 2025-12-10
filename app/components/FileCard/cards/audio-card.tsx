import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '~/lib/utils';
import { ExternalLink, Pin, Download, Share2, Trash2, Volume2 } from 'lucide-react';
import type { BaseCardProps, ContextMenuAction } from '../types';
import { ContextMenuWrapper } from '../context-menu';
import { MatchContext } from '../ui/match-context';
import { DeleteConfirmDialog } from '../ui/delete-confirm-dialog';
import {
  downloadFile,
  shareFile,
  canShare,
  togglePin,
  getFileLibraryUrl,
  getRawFileUrl,
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
}: BaseCardProps) {
  const navigate = useNavigate();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const src = getRawFileUrl(file.path);
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
    };
  }, []);

  const handleClick = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play();
      setIsPlaying(true);
    }
  };

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

  const barWidth = duration > 0 ? getBarWidth(duration) : '100px';

  const cardContent = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-full border border-border bg-muted touch-callout-none select-none cursor-pointer',
        'h-10 min-w-[100px]',
        className
      )}
      style={{ width: barWidth }}
      onClick={handleClick}
    >
      {/* Progress background */}
      <div
        className="absolute inset-0 bg-primary/20 transition-all duration-100"
        style={{ width: `${progress}%` }}
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
      <DeleteConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        fileName={file.name}
        filePath={file.path}
      />
    </>
  );
}
