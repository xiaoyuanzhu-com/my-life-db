/**
 * URL Crawl Summary Renderer
 * Displays AI-generated summary of crawled URL content
 */

import type { DigestRendererProps } from './index';

interface UrlCrawlSummary {
  summary?: string;
}

export function UrlCrawlSummaryRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No summary available
      </p>
    );
  }

  let summary: string;
  try {
    const data: UrlCrawlSummary = JSON.parse(content);
    summary = data.summary ?? content;
  } catch {
    // Fallback for plain text summary
    summary = content;
  }

  return (
    <p className="mt-2 text-sm text-foreground leading-relaxed">
      {summary}
    </p>
  );
}
