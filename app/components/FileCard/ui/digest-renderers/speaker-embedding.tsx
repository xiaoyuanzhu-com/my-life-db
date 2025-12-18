/**
 * Speaker Embedding Renderer
 * Displays speaker IDs as tags/chips
 */

import { User } from 'lucide-react';
import type { DigestRendererProps } from './index';

interface ProcessedSpeaker {
  speakerId: string;
  embeddingId: string;
  clusterId: string;
  peopleId: string;
  isNewPeople: boolean;
  duration: number;
  segmentCount: number;
}

interface SpeakerEmbeddingContent {
  speakersProcessed: number;
  speakersSkipped: number;
  processed: ProcessedSpeaker[];
  skipped?: { speakerId: string; reason: string }[];
  reason?: string;
  existingEmbeddings?: number;
}

// Speaker colors for differentiation
const SPEAKER_COLORS = [
  'bg-blue-500/15 text-blue-600',
  'bg-teal-500/15 text-teal-600',
  'bg-amber-500/15 text-amber-600',
  'bg-purple-500/15 text-purple-600',
  'bg-pink-500/15 text-pink-600',
  'bg-cyan-500/15 text-cyan-600',
];

function getSpeakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m${secs}s`;
}

export function SpeakerEmbeddingRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No speaker data
      </p>
    );
  }

  let data: SpeakerEmbeddingContent;
  try {
    data = JSON.parse(content);
  } catch {
    return (
      <p className="text-sm text-muted-foreground italic">
        Invalid speaker data
      </p>
    );
  }

  // Handle special cases
  if (data.reason === 'no_sufficient_speakers') {
    return (
      <p className="text-sm text-muted-foreground italic">
        No speakers with sufficient duration
      </p>
    );
  }

  if (data.reason === 'already_processed' && data.existingEmbeddings) {
    return (
      <p className="text-sm text-muted-foreground">
        {data.existingEmbeddings} speaker{data.existingEmbeddings > 1 ? 's' : ''} identified
      </p>
    );
  }

  const speakers = data.processed ?? [];
  if (speakers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No speakers detected
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {speakers.map((speaker, i) => (
        <span
          key={speaker.speakerId}
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${getSpeakerColor(i)}`}
          title={`${speaker.segmentCount} segment${speaker.segmentCount > 1 ? 's' : ''}, ${formatDuration(speaker.duration)}`}
        >
          <User className="h-3 w-3" />
          {speaker.speakerId}
        </span>
      ))}
    </div>
  );
}
