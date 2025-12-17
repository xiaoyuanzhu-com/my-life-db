/**
 * Search Semantic Renderer
 * Displays which sources are indexed for semantic vector search
 */

import type { DigestRendererProps } from './index';

interface SourceChunkInfo {
  chunkCount: number;
}

interface SearchSemanticContent {
  taskId: number;
  textSource: string;
  totalChunks: number;
  sources: Record<string, SourceChunkInfo>;
  documentIds: number;
  enqueuedAt: string;
}

const SOURCE_LABELS: Record<string, string> = {
  'content': 'Content',
  'summary': 'Summary',
  'tags': 'Tags',
};

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

  // Get source keys from the sources object
  const sourceKeys = data.sources ? Object.keys(data.sources) : [];

  if (sourceKeys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Not indexed (no text content)
      </p>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {sourceKeys.map((source) => (
          <span
            key={source}
            className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/15 text-primary"
          >
            {SOURCE_LABELS[source] || source}
          </span>
        ))}
      </div>
    </div>
  );
}
