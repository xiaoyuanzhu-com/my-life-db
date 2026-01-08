import { useState, useCallback, useEffect, useRef } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export interface AudioSyncState {
  currentTime: number;
  onSeek: (time: number) => void;
}

interface AudioContentProps {
  file: FileWithDigests;
  /** Callback to expose audio sync state for transcript highlighting */
  onAudioSyncChange?: (sync: AudioSyncState | null) => void;
}

export function AudioContent({ file, onAudioSyncChange }: AudioContentProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const progressRef = useRef<HTMLDivElement>(null);
  const src = getFileContentUrl(file);

  // Callback ref to capture audio element when it mounts
  const audioRef = useCallback((node: HTMLAudioElement | null) => {
    setAudioElement(node);
  }, []);

  // Seek handler for external control (e.g., clicking on transcript)
  const handleSeek = useCallback((time: number) => {
    if (!audioElement) return;
    audioElement.currentTime = time;
  }, [audioElement]);

  // Expose audio sync state to parent
  useEffect(() => {
    if (onAudioSyncChange) {
      if (audioElement) {
        onAudioSyncChange({ currentTime, onSeek: handleSeek });
      } else {
        onAudioSyncChange(null);
      }
    }
  }, [currentTime, handleSeek, audioElement, onAudioSyncChange]);

  // Reset state when file changes
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackSpeed(1);
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
      audioElement.playbackRate = 1;
    }
  }, [file.path, audioElement]);

  // Audio event handlers
  useEffect(() => {
    if (!audioElement) return;

    const handleLoadedMetadata = () => {
      setDuration(audioElement.duration);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audioElement.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audioElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    audioElement.addEventListener('timeupdate', handleTimeUpdate);
    audioElement.addEventListener('ended', handleEnded);
    audioElement.addEventListener('play', handlePlay);
    audioElement.addEventListener('pause', handlePause);

    // If metadata already loaded, get duration immediately
    if (audioElement.readyState >= 1) {
      setDuration(audioElement.duration);
    }

    return () => {
      audioElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audioElement.removeEventListener('timeupdate', handleTimeUpdate);
      audioElement.removeEventListener('ended', handleEnded);
      audioElement.removeEventListener('play', handlePlay);
      audioElement.removeEventListener('pause', handlePause);
    };
  }, [audioElement]);

  const handlePlayPause = useCallback(() => {
    if (!audioElement) return;

    if (isPlaying) {
      audioElement.pause();
    } else {
      audioElement.play();
    }
  }, [isPlaying, audioElement]);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const progress = progressRef.current;
    if (!audioElement || !progress || !duration) return;

    const rect = progress.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    audioElement.currentTime = ratio * duration;
  }, [duration, audioElement]);

  const handleSpeedChange = useCallback(() => {
    const speeds = [0.5, 1, 1.5, 2];
    const currentIndex = speeds.indexOf(playbackSpeed);
    const nextIndex = (currentIndex + 1) % speeds.length;
    const newSpeed = speeds[nextIndex];
    setPlaybackSpeed(newSpeed);
    if (audioElement) {
      audioElement.playbackRate = newSpeed;
    }
  }, [playbackSpeed, audioElement]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
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

        {/* Play/Pause and Speed controls */}
        <div className="flex justify-center items-center gap-4">
          <button
            onClick={handleSpeedChange}
            className={cn(
              'w-12 h-12 rounded-full flex items-center justify-center',
              'bg-muted text-muted-foreground',
              'hover:bg-muted/80 transition-colors',
              'text-sm font-medium touch-manipulation'
            )}
            aria-label={`Playback speed: ${playbackSpeed}x`}
          >
            {playbackSpeed}x
          </button>
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
          {/* Spacer for symmetry */}
          <div className="w-12 h-12" />
        </div>

        {/* Hidden audio element */}
        <audio ref={audioRef} src={src} preload="metadata" />
      </div>
    </div>
  );
}
