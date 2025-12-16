/**
 * URL Crawl Screenshot Renderer
 * Displays the screenshot captured from a crawled URL
 */

import type { DigestRendererProps } from './index';

export function UrlCrawlScreenshotRenderer({ sqlarName, filePath }: DigestRendererProps) {
  if (!sqlarName) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No screenshot available
      </p>
    );
  }

  const screenshotUrl = `/api/digest/${encodeURIComponent(filePath)}/screenshot`;

  return (
    <div className="mt-2">
      <img
        src={screenshotUrl}
        alt="Page screenshot"
        className="w-full max-h-48 object-contain rounded border border-border bg-muted"
        loading="lazy"
      />
    </div>
  );
}
