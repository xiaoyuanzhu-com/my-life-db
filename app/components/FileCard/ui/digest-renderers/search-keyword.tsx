/**
 * Search Keyword Renderer
 * Displays which sources are indexed for keyword search
 */

import { CheckCircle2 } from 'lucide-react';
import type { DigestRendererProps } from './index';

interface SearchKeywordContent {
  documentId: number;
  taskId: number;
  textSource: string;
  hasContent: boolean;
  hasSummary: boolean;
  hasTags: boolean;
  enqueuedAt: string;
}

const SOURCE_LABELS: Record<string, string> = {
  'filename-only': 'Filename',
  'text-preview': 'Text Preview',
  'url-crawl-content': 'URL Content',
  'doc-to-markdown': 'Document Text',
  'image-ocr': 'OCR Text',
  'image-captioning': 'Image Caption',
  'speech-recognition': 'Transcription',
};

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

  // Primary text source
  if (data.textSource && data.textSource !== 'filename-only') {
    indexed.push(SOURCE_LABELS[data.textSource] || data.textSource);
  }

  // Additional indexed fields
  if (data.hasSummary) indexed.push('Summary');
  if (data.hasTags) indexed.push('Tags');

  // Always has filename
  indexed.push('Filename');

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {indexed.map((source, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-muted text-muted-foreground"
          >
            <CheckCircle2 className="h-3 w-3" />
            {source}
          </span>
        ))}
      </div>
    </div>
  );
}
