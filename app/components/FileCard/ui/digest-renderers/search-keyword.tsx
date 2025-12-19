/**
 * Search Keyword Renderer
 * Displays which sources are indexed for keyword search
 */

import type { DigestRendererProps } from './index';
import { TEXT_SOURCE_LABELS, SUMMARY_SOURCE_LABELS } from '~/types/text-source';
import type { SummarySourceType } from '~/types/text-source';

interface SearchKeywordContent {
  documentId: number;
  taskId: number;
  textSource: string;
  hasContent: boolean;
  hasSummary: boolean;
  summarySource: string | null;
  hasTags: boolean;
  enqueuedAt: string;
}

export function SearchKeywordRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Not indexed
      </p>
    );
  }

  let data: SearchKeywordContent;
  try {
    data = JSON.parse(content);
  } catch {
    return (
      <p className="text-sm text-muted-foreground italic">
        Invalid index data
      </p>
    );
  }

  const indexed: string[] = [];

  // Primary text source (use label from shared source of truth)
  const sourceLabel = TEXT_SOURCE_LABELS[data.textSource as keyof typeof TEXT_SOURCE_LABELS];
  if (sourceLabel && data.textSource !== 'filename-only') {
    indexed.push(sourceLabel);
  }

  // Additional indexed fields
  if (data.hasSummary) {
    const summaryLabel = data.summarySource
      ? SUMMARY_SOURCE_LABELS[data.summarySource as SummarySourceType] ?? 'Summary'
      : 'Summary';
    indexed.push(summaryLabel);
  }
  if (data.hasTags) indexed.push('Tags');

  // Always has filename
  indexed.push(TEXT_SOURCE_LABELS['filename-only']);

  return (
    <div className="mt-2 space-y-1.5">
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
