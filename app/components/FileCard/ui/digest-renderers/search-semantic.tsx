/**
 * Search Semantic Renderer
 * Displays which sources are indexed for semantic vector search
 */

import type { DigestRendererProps } from './index';
import { TEXT_SOURCE_LABELS } from '~/types/text-source';
import type { TextSourceType } from '~/types/text-source';

/**
 * New format: sources is Record<string, number> mapping source type to chunk count
 * e.g., { "image-ocr": 1, "image-captioning": 1, "tags": 1 }
 */
interface SearchSemanticContent {
  sources: Record<string, number>;
  totalChunks: number;
  documentIds: number;
  completedAt: string;
}

/**
 * Get human-readable label for a source type
 */
function getSourceLabel(sourceType: string): string {
  // Check if it's a known text source type
  if (sourceType in TEXT_SOURCE_LABELS) {
    return TEXT_SOURCE_LABELS[sourceType as TextSourceType];
  }
  // Special cases
  if (sourceType === 'summary') return 'Summary';
  if (sourceType === 'tags') return 'Tags';
  // Fall back to formatted source type
  return sourceType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

  // Build list of indexed sources from the sources object
  const indexed: string[] = [];

  if (data.sources) {
    for (const sourceType of Object.keys(data.sources)) {
      indexed.push(getSourceLabel(sourceType));
    }
  }

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
