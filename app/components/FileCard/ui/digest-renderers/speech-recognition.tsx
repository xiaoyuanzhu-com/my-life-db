/**
 * Speech Recognition Renderer
 * Displays transcribed audio with speaker diarization
 */

import { User } from 'lucide-react';
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

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSpeakerColor(speaker: string): string {
  // Generate consistent color based on speaker name
  const colors = [
    'text-blue-500',
    'text-emerald-500',
    'text-purple-500',
    'text-orange-500',
    'text-pink-500',
    'text-cyan-500',
  ];
  const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

export function SpeechRecognitionRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No transcription available
      </p>
    );
  }

  let data: SpeechRecognitionContent;
  try {
    data = JSON.parse(content);
  } catch {
    // Plain text transcription
    return (
      <p className="mt-2 text-sm text-foreground whitespace-pre-wrap">
        {content}
      </p>
    );
  }

  // If we have segments with speaker info, show diarized view
  if (data.segments && data.segments.length > 0) {
    const hasSpeakers = data.segments.some(s => s.speaker);

    if (hasSpeakers) {
      // Group consecutive segments by speaker
      const grouped: { speaker: string; text: string; start: number; end: number }[] = [];
      let current: { speaker: string; text: string; start: number; end: number } | null = null;

      for (const segment of data.segments) {
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

      return (
        <div className="mt-2 space-y-3 max-h-64 overflow-y-auto">
          {grouped.map((group, i) => (
            <div key={i} className="flex gap-2">
              <div className="flex-shrink-0 pt-0.5">
                <div className={`flex items-center gap-1 text-xs font-medium ${getSpeakerColor(group.speaker)}`}>
                  <User className="h-3 w-3" />
                  <span>{group.speaker}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {formatTime(group.start)}
                </div>
              </div>
              <p className="text-sm text-foreground flex-1">
                {group.text}
              </p>
            </div>
          ))}
        </div>
      );
    }

    // Segments without speaker info - simple transcript
    const fullText = data.segments.map(s => s.text.trim()).join(' ');
    return (
      <p className="mt-2 text-sm text-foreground whitespace-pre-wrap line-clamp-6">
        {fullText}
      </p>
    );
  }

  // Fallback to plain text
  if (data.text) {
    return (
      <p className="mt-2 text-sm text-foreground whitespace-pre-wrap line-clamp-6">
        {data.text}
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground italic">
      No transcription available
    </p>
  );
}
