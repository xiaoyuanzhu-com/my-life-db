import 'server-only';
/**
 * Digest Layer - URL Crawl
 * Business-facing function to crawl a URL and produce a digest-friendly output.
 */

import { crawlUrlWithHaid } from '@/lib/vendors/haid';

export interface UrlCrawlInput {
  url: string;
  timeoutMs?: number;
}

export interface UrlCrawlOutput {
  url: string;
  redirectedTo?: string | null;
  html?: string;
  metadata?: {
    title?: string;
    description?: string;
    author?: string;
    publishedDate?: string;
    image?: string;
    siteName?: string;
    domain?: string;
  };
}

export async function crawlUrlDigest(input: UrlCrawlInput): Promise<UrlCrawlOutput> {
  // Use HAID vendor to perform actual crawl (placeholder for now)
  const res = await crawlUrlWithHaid({ url: input.url, timeoutMs: input.timeoutMs });
  return {
    url: res.url,
    redirectedTo: res.redirectedTo ?? null,
    html: res.html,
    metadata: res.metadata,
  };
}

