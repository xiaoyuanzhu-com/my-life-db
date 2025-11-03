/**
 * HAID (Home AI Daemon) vendor wrapper
 * Placeholder interfaces for URL crawling (docs to be provided later).
 * Keep this layer business-unrelated and aligned to the external service.
 */

import { getSettings } from '@/lib/config/storage';

export interface HaidCrawlOptions {
  url: string;
  timeoutMs?: number;
}

export interface HaidCrawlResponse {
  url: string;
  redirectedTo?: string | null;
  html: string;
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

/**
 * Crawl a URL via HAID.
 * Placeholder implementation until HAID docs are provided.
 */
export async function crawlUrlWithHaid(
  options: HaidCrawlOptions
): Promise<HaidCrawlResponse> {
  const settings = await getSettings();
  const vendorConfig = settings.vendors?.homelabAi || settings.vendors?.haid;

  // Placeholder: emit minimal stub content to unblock development.
  // When API details are available, replace this with a real HTTP call to HAID.
  const baseUrl = vendorConfig?.baseUrl || 'http://localhost:8000';
  void baseUrl; // reserved for future use

  return {
    url: options.url,
    redirectedTo: null,
    html: '<!-- haid placeholder html -->',
    metadata: {
      title: 'Placeholder Title',
      description: 'Placeholder description from HAID crawl stub.',
      siteName: 'placeholder.site',
      domain: 'placeholder.site',
    },
  };
}

