'use client';

import { Play } from 'lucide-react';

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface TranscriptData {
  text: string;
  language: string;
  segments: TranscriptSegment[];
}

interface TranscriptViewerProps {
  data: TranscriptData;
  onSeek?: (time: number) => void;
}

// Speaker colors for differentiation
const SPEAKER_COLORS = [
  { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', avatar: 'bg-blue-500' },
  { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-300', avatar: 'bg-green-500' },
  { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300', avatar: 'bg-purple-500' },
  { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300', avatar: 'bg-orange-500' },
  { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-300', avatar: 'bg-pink-500' },
  { bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-700 dark:text-teal-300', avatar: 'bg-teal-500' },
  { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', avatar: 'bg-red-500' },
  { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-300', avatar: 'bg-indigo-500' },
];

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSpeakerColor(speaker: string, speakerMap: Map<string, number>) {
  if (!speakerMap.has(speaker)) {
    speakerMap.set(speaker, speakerMap.size);
  }
  const index = speakerMap.get(speaker)!;
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

function getSpeakerInitial(speaker: string): string {
  // Extract last digit from "SPEAKER_00" format or use first char
  const match = speaker.match(/(\d)$/);
  if (match) {
    return match[1];
  }
  return speaker.charAt(0).toUpperCase();
}

export function TranscriptViewer({ data, onSeek }: TranscriptViewerProps) {
  const speakerMap = new Map<string, number>();

  // Group consecutive segments by speaker
  const groupedSegments: { speaker: string; segments: TranscriptSegment[] }[] = [];

  for (const segment of data.segments) {
    const lastGroup = groupedSegments[groupedSegments.length - 1];
    if (lastGroup && lastGroup.speaker === segment.speaker) {
      lastGroup.segments.push(segment);
    } else {
      groupedSegments.push({ speaker: segment.speaker, segments: [segment] });
    }
  }

  const handleSegmentClick = (startTime: number) => {
    if (onSeek) {
      onSeek(startTime);
    }
  };

  return (
    <div className="space-y-4">
      {data.language && (
        <div className="text-xs text-muted-foreground">
          Language: {data.language}
        </div>
      )}

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {groupedSegments.map((group, groupIndex) => {
          const color = getSpeakerColor(group.speaker, speakerMap);
          const initial = getSpeakerInitial(group.speaker);

          return (
            <div key={groupIndex} className="flex gap-3">
              {/* Speaker Avatar */}
              <div
                className={`flex-shrink-0 w-8 h-8 rounded-full ${color.avatar} flex items-center justify-center text-white text-sm font-medium`}
                title={group.speaker}
              >
                {initial}
              </div>

              {/* Segments */}
              <div className="flex-1 space-y-1">
                {group.segments.map((segment, segIndex) => (
                  <button
                    key={segIndex}
                    onClick={() => handleSegmentClick(segment.start)}
                    className={`group w-full text-left p-2 rounded-lg ${color.bg} hover:opacity-80 transition-opacity`}
                    disabled={!onSeek}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`flex-shrink-0 text-xs ${color.text} opacity-70 pt-0.5 font-mono`}>
                        {formatTime(segment.start)}
                      </span>
                      <span className="flex-1 text-sm">{segment.text}</span>
                      {onSeek && (
                        <Play className={`flex-shrink-0 w-4 h-4 ${color.text} opacity-0 group-hover:opacity-70 transition-opacity`} />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
