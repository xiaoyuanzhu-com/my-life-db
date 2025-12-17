import { useState, useCallback, useEffect, useRef } from 'react';
import { Download, Share2, Sparkles, Play, Pause, Volume2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { cn } from '~/lib/utils';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { getFileContentUrl, downloadFile, shareFile, canShare, isIOS } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';
import { ModalLayout, useModalLayout, getModalContainerStyles } from '../ui/modal-layout';

type ModalView = 'content' | 'digests';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function AudioModal({ file, open, onOpenChange }: BaseModalProps) {
  const [activeView, setActiveView] = useState<ModalView>('content');
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const layout = useModalLayout();
  const src = getFileContentUrl(file);

  // Reset view and state when modal opens
  useEffect(() => {
    if (open) {
      setActiveView('content');
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [open]);

  // Audio event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, []);

  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
  }, [isPlaying]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    const progress = progressRef.current;
    if (!audio || !progress || !duration) return;

    const rect = progress.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    audio.currentTime = ratio * duration;
  }, [duration]);

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
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

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
          contentClassName="flex items-center justify-center"
        >
          <div className="w-full h-full flex items-center justify-center bg-background">
            <div className="w-full max-w-md px-8 space-y-6">
              {/* Audio icon */}
              <div className="flex justify-center">
                <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center">
                  <Volume2 className="w-12 h-12 text-primary" />
                </div>
              </div>

              {/* Filename */}
              <p className="text-center text-sm text-muted-foreground truncate">
                {file.name}
              </p>

              {/* Progress bar */}
              <div
                ref={progressRef}
                className="h-2 bg-muted rounded-full cursor-pointer overflow-hidden"
                onClick={handleProgressClick}
              >
                <div
                  className="h-full bg-primary rounded-full transition-all duration-100"
                  style={{ width: `${progress}%` }}
                />
              </div>

              {/* Time display */}
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>

              {/* Play/Pause button */}
              <div className="flex justify-center">
                <button
                  onClick={handlePlayPause}
                  className={cn(
                    'w-14 h-14 rounded-full flex items-center justify-center',
                    'bg-primary text-primary-foreground',
                    'hover:bg-primary/90 transition-colors',
                    'touch-manipulation'
                  )}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause className="w-6 h-6" />
                  ) : (
                    <Play className="w-6 h-6 ml-1" />
                  )}
                </button>
              </div>

              {/* Hidden audio element */}
              <audio ref={audioRef} src={src} preload="metadata" />
            </div>
          </div>
        </ModalLayout>
      </DialogContent>
    </Dialog>
  );
}
