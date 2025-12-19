/**
 * Search Semantic Renderer
 * Displays which sources are indexed for semantic vector search
 */

import type { DigestRendererProps } from './index';
import { TEXT_SOURCE_LABELS, SUMMARY_SOURCE_LABELS } from '~/types/text-source';
import type { SummarySourceType } from '~/types/text-source';

interface SourceChunkInfo {
  chunkCount: number;
}

interface SearchSemanticContent {
  taskId: number;
  textSource: string;
  totalChunks: number;
  sources: Record<string, SourceChunkInfo>;
  summarySource: string | null;
  documentIds: number;
  enqueuedAt: string;
}

export function SearchSemanticRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Not indexed (no text content)
      </p>
    );
  }

  let data: SearchSemanticContent;
  try {
    data = JSON.parse(content);
  } catch {
    return (
      <p className="text-sm text-muted-foreground italic">
        Invalid index data
      </p>
    );
  }

  // Build list of indexed sources using shared labels (same as keyword search)
  const indexed: string[] = [];

  // Primary text source (use label from shared source of truth)
  const sourceLabel = TEXT_SOURCE_LABELS[data.textSource as keyof typeof TEXT_SOURCE_LABELS];
  if (sourceLabel) {
    indexed.push(sourceLabel);
  }

  // Additional indexed fields from sources object
  if (data.sources?.summary) {
    const summaryLabel = data.summarySource
      ? SUMMARY_SOURCE_LABELS[data.summarySource as SummarySourceType] ?? 'Summary'
      : 'Summary';
    indexed.push(summaryLabel);
  }
  if (data.sources?.tags) indexed.push('Tags');

  if (indexed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Not indexed (no text content)
      </p>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {indexed.map((source, i) => (
          <span
            key={i}
            className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/15 text-primary"
          >
            {source}
          </span>
        ))}
      </div>
    </div>
  );
}
