/**
 * Digest Layer - URL Crawl
 * Business-facing function to crawl a URL and produce a digest-friendly output.
 */

import { crawlUrlWithHaid } from '~/.server/vendors/haid';

export interface UrlCrawlInput {
  url: string;
  timeoutMs?: number;
}

export interface UrlCrawlOutput {
  url: string;
  redirectedTo?: string | null;
  html?: string;
  markdown?: string | null;
  metadata?: {
    title?: string;
    description?: string;
    author?: string;
    publishedDate?: string;
    image?: string;
    siteName?: string;
    domain?: string;
  };
  screenshot?: {
    base64: string;
    mimeType: string;
  } | null;
}

export async function crawlUrlDigest(input: UrlCrawlInput): Promise<UrlCrawlOutput> {
  // Use HAID vendor to perform actual crawl
  const res = await crawlUrlWithHaid({
    url: input.url,
    timeoutMs: input.timeoutMs,
    screenshot: true,
    pageTimeout: input.timeoutMs,
  });

  if ((!res.html || res.html.trim().length === 0) && (!res.markdown || res.markdown.trim().length === 0)) {
    throw new Error('HAID crawl returned empty content');
  }

  return {
    url: res.url,
    redirectedTo: res.redirectedTo ?? null,
    html: res.html ?? undefined,
    metadata: res.metadata,
    markdown: res.markdown ?? null,
    screenshot: res.screenshot ?? null,
  };
}
