/**
 * Speech Recognition Renderer
 * Displays transcribed audio with speaker diarization
 * Supports optional sync with audio playback (highlight, scroll, seek)
 */

import { useEffect, useRef, useMemo } from 'react';
import { User } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { DigestRendererProps } from './index';

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface SpeechRecognitionContent {
  segments?: Segment[];
  text?: string;
  language?: string;
}

interface GroupedSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSpeakerColor(speaker: string): string {
  // Generate consistent color based on speaker name
  const colors = [
    'text-blue-500',
    'text-teal-500',
    'text-purple-500',
    'text-orange-500',
    'text-pink-500',
    'text-cyan-500',
  ];
  const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

function groupSegmentsBySpeaker(segments: Segment[]): GroupedSegment[] {
  const grouped: GroupedSegment[] = [];
  let current: GroupedSegment | null = null;

  for (const segment of segments) {
    const speaker = segment.speaker ?? 'Unknown';
    if (current && current.speaker === speaker) {
      current.text += ' ' + segment.text.trim();
      current.end = segment.end;
    } else {
      if (current) grouped.push(current);
      current = {
        speaker,
        text: segment.text.trim(),
        start: segment.start,
        end: segment.end,
      };
    }
  }
  if (current) grouped.push(current);

  return grouped;
}

interface Props {
  content: string | null;
  sqlarName?: string | null;
  filePath?: string;
  /** Current playback time in seconds (enables sync mode) */
  currentTime?: number;
  /** Callback when user clicks a segment to seek */
  onSeek?: (time: number) => void;
}

export function SpeechRecognitionRenderer({ content, currentTime, onSeek }: Props) {
  const isSynced = currentTime !== undefined && onSeek !== undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const activeSegmentRef = useRef<HTMLDivElement>(null);

  // Parse content and group segments
  const { segments, hasSpeakers, plainText } = useMemo(() => {
    if (!content) return { segments: [], hasSpeakers: false, plainText: null };

    let data: SpeechRecognitionContent;
    try {
      data = JSON.parse(content);
    } catch {
      return { segments: [], hasSpeakers: false, plainText: content };
    }

    if (!data.segments || data.segments.length === 0) {
      return { segments: [], hasSpeakers: false, plainText: data.text ?? null };
    }

    const hasSpeakers = data.segments.some(s => s.speaker);
    const segments = hasSpeakers
      ? groupSegmentsBySpeaker(data.segments)
      : data.segments.map(s => ({
          speaker: '',
          text: s.text.trim(),
          start: s.start,
          end: s.end,
        }));

    return { segments, hasSpeakers, plainText: null };
  }, [content]);

  // Find active segment index when syncing
  const activeIndex = useMemo(() => {
    if (!isSynced || segments.length === 0 || currentTime === undefined) return -1;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (currentTime >= seg.start && currentTime < seg.end) {
        return i;
      }
    }

    // If past all segments, highlight last one
    if (currentTime >= segments[segments.length - 1].end) {
      return segments.length - 1;
    }

    return -1;
  }, [segments, currentTime, isSynced]);

  // Auto-scroll to active segment
  useEffect(() => {
    if (isSynced && activeIndex >= 0 && activeSegmentRef.current && containerRef.current) {
      activeSegmentRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  }, [isSynced, activeIndex]);

  // No content
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No transcription available
      </p>
    );
  }

  // Plain text fallback
  if (plainText) {
    return (
      <p className={cn('mt-2 text-sm text-foreground whitespace-pre-wrap', !isSynced && 'line-clamp-6')}>
        {plainText}
      </p>
    );
  }

  // No segments
  if (segments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No transcription available
      </p>
    );
  }

  // Segments without speakers and no sync - just show text
  if (!hasSpeakers && !isSynced) {
    const fullText = segments.map(s => s.text).join(' ');
    return (
      <p className="mt-2 text-sm text-foreground whitespace-pre-wrap line-clamp-6">
        {fullText}
      </p>
    );
  }

  // Full segment view (with or without sync)
  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-y-auto',
        isSynced ? 'h-full' : 'mt-2 max-h-64 space-y-1'
      )}
    >
      {segments.map((segment, i) => {
        const isActive = isSynced && i === activeIndex;

        return (
          <div
            key={i}
            ref={isActive ? activeSegmentRef : undefined}
            onClick={isSynced && onSeek ? () => onSeek(segment.start) : undefined}
            className={cn(
              'py-1 px-2 rounded-md transition-colors',
              isSynced && 'cursor-pointer',
              isActive && 'bg-muted',
              isSynced && !isActive && 'hover:bg-muted/50'
            )}
          >
            {hasSpeakers ? (
              <div className="flex gap-2">
                <div className="flex-shrink-0 pt-0.5">
                  <div className={cn('flex items-center gap-1 text-xs font-medium', getSpeakerColor(segment.speaker))}>
                    <User className="h-3 w-3" />
                    <span>{segment.speaker}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {formatTime(segment.start)}
                  </div>
                </div>
                <p className="text-sm text-foreground flex-1">
                  {segment.text}
                </p>
              </div>
            ) : (
              <div className="flex gap-2">
                <span className="text-xs text-muted-foreground flex-shrink-0 w-10">
                  {formatTime(segment.start)}
                </span>
                <p className="text-sm text-foreground flex-1">
                  {segment.text}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
