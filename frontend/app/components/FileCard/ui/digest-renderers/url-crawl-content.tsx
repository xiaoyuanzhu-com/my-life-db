/**
 * URL Crawl Content Renderer
 * Displays extracted content and metadata from a crawled URL
 */

import { ExternalLink, Clock, FileText } from 'lucide-react';
import type { DigestRendererProps } from './index';

interface UrlCrawlContent {
  markdown?: string;
  url?: string;
  title?: string;
  description?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  siteName?: string;
  domain?: string;
  wordCount?: number;
  readingTimeMinutes?: number;
}

export function UrlCrawlContentRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No content extracted
      </p>
    );
  }

  let data: UrlCrawlContent;
  try {
    data = JSON.parse(content);
  } catch {
    // Fallback for plain markdown content
    return (
      <div className="mt-2 text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
        {content}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {/* Title */}
      {data.title && (
        <h4 className="text-sm font-medium text-foreground line-clamp-2">
          {data.title}
        </h4>
      )}

      {/* Metadata row */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {data.domain && (
          <span className="flex items-center gap-1">
            <ExternalLink className="h-3 w-3" />
            {data.domain}
          </span>
        )}
        {data.wordCount !== undefined && data.wordCount > 0 && (
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {data.wordCount.toLocaleString()} words
          </span>
        )}
        {data.readingTimeMinutes !== undefined && data.readingTimeMinutes > 0 && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {data.readingTimeMinutes} min read
          </span>
        )}
      </div>

      {/* Description */}
      {data.description && (
        <p className="text-sm text-muted-foreground line-clamp-3">
          {data.description}
        </p>
      )}

      {/* Content preview */}
      {data.markdown && !data.description && (
        <p className="text-sm text-muted-foreground line-clamp-3">
          {data.markdown.slice(0, 300)}
          {data.markdown.length > 300 && '...'}
        </p>
      )}
    </div>
  );
}
