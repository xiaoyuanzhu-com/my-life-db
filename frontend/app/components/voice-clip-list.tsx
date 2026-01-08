import { useState, useRef, useCallback } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';

interface VoiceSegment {
  start: number;
  end: number;
  text: string;
}

interface VoiceClip {
  id: string;
  sourcePath: string;
  segmentsWithText: VoiceSegment[];
}

interface VoiceClipListProps {
  clips: VoiceClip[];
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function VoiceClipList({ clips }: VoiceClipListProps) {
  const [playingSegmentKey, setPlayingSegmentKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimeRef = useRef<number | null>(null);

  const handlePlay = useCallback((sourcePath: string, segment: VoiceSegment, segmentKey: string) => {
    // Build raw URL for the audio file
    const encodedPath = sourcePath
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const rawUrl = `/raw/${encodedPath}`;

    // If same segment is playing, pause it
    if (playingSegmentKey === segmentKey && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlayingSegmentKey(null);
      return;
    }

    // Create or reuse audio element
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.addEventListener('ended', () => {
        setPlayingSegmentKey(null);
        stopTimeRef.current = null;
      });
    }

    const audio = audioRef.current;

    // Stop at segment end
    const handleTimeUpdate = () => {
      if (stopTimeRef.current !== null && audio.currentTime >= stopTimeRef.current) {
        audio.pause();
        setPlayingSegmentKey(null);
        stopTimeRef.current = null;
        audio.removeEventListener('timeupdate', handleTimeUpdate);
      }
    };

    // Set up new playback
    const needsNewSrc = audio.src !== window.location.origin + rawUrl;
    if (needsNewSrc) {
      audio.src = rawUrl;
    }

    stopTimeRef.current = segment.end;
    setPlayingSegmentKey(segmentKey);

    // Wait for audio to be ready, then seek and play
    const seekAndPlay = () => {
      audio.currentTime = segment.start;
      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.play().catch(() => {
        setPlayingSegmentKey(null);
      });
    };

    if (!needsNewSrc && audio.readyState >= 1) {
      seekAndPlay();
    } else {
      audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      if (needsNewSrc) {
        audio.load();
      }
    }
  }, [playingSegmentKey]);

  // Flatten clips into segments grouped by source file
  const segmentsBySource: Record<string, { clipId: string; segment: VoiceSegment; index: number }[]> = {};
  for (const clip of clips) {
    if (!segmentsBySource[clip.sourcePath]) {
      segmentsBySource[clip.sourcePath] = [];
    }
    clip.segmentsWithText.forEach((segment, index) => {
      segmentsBySource[clip.sourcePath].push({ clipId: clip.id, segment, index });
    });
  }

  // Sort segments by start time within each source
  for (const sourcePath of Object.keys(segmentsBySource)) {
    segmentsBySource[sourcePath].sort((a, b) => a.segment.start - b.segment.start);
  }

  const totalSegments = Object.values(segmentsBySource).reduce((sum, segs) => sum + segs.length, 0);

  if (totalSegments === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No voice clips available.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Object.entries(segmentsBySource).map(([sourcePath, segments]) => (
        <div key={sourcePath} className="space-y-2">
          {/* Source file header */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Volume2 className="h-4 w-4" />
            <span className="font-medium">{sourcePath.split('/').pop()}</span>
            <span className="text-xs">({segments.length} segments)</span>
          </div>

          {/* Segments from this source */}
          <div className="space-y-1">
            {segments.map(({ clipId, segment, index }) => {
              const segmentKey = `${clipId}-${index}`;
              const isPlaying = playingSegmentKey === segmentKey;
              const duration = segment.end - segment.start;

              return (
                <button
                  key={segmentKey}
                  onClick={() => handlePlay(sourcePath, segment, segmentKey)}
                  className={`group w-full text-left p-3 rounded-lg transition-colors ${
                    isPlaying
                      ? 'bg-primary/10 border border-primary/20'
                      : 'bg-muted/50 hover:bg-muted border border-transparent'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Play button */}
                    <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                      isPlaying ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/20 group-hover:bg-primary/20'
                    }`}>
                      {isPlaying ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4 ml-0.5" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Transcript text */}
                      <p className={`text-sm leading-relaxed ${
                        segment.text ? 'text-foreground' : 'text-muted-foreground italic'
                      }`}>
                        {segment.text || 'No transcript available'}
                      </p>

                      {/* Time info */}
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>{formatTime(segment.start)} - {formatTime(segment.end)}</span>
                        <span className="text-muted-foreground/60">
                          ({Math.round(duration)}s)
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
