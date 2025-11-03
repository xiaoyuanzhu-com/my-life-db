/**
 * HAID (Home AI Daemon) vendor wrapper
 * Placeholder interfaces for URL crawling (docs to be provided later).
 * Keep this layer business-unrelated and aligned to the external service.
 */

import { getSettings } from '@/lib/config/storage';

export interface HaidCrawlOptions {
  url: string;
  timeoutMs?: number;
  screenshot?: boolean; // default: false
  waitForJs?: boolean;  // default: true
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
  const vendorConfig = settings.vendors?.homelabAi || (settings as any)?.vendors?.haid;

  const baseUrl = (vendorConfig?.baseUrl || 'https://haid.home.iloahz.com').replace(/\/$/, '');
  const endpoint = `${baseUrl}/api/crawl`;

  const payload = {
    url: options.url,
    screenshot: options.screenshot ?? false,
    wait_for_js: options.waitForJs ?? true,
  } as const;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HAID crawl error ${resp.status}: ${text || resp.statusText}`);
    }

    // Try parse JSON; if fails, treat as text
    let data: any;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else {
      const htmlText = await resp.text();
      data = { html: htmlText, url: options.url };
    }

    // Normalize response fields
    const resUrl = data.url || options.url;
    const redirectedTo = data.redirected_to || data.redirectedTo || null;
    const html = data.html || data.content || data.body || '';

    const meta = data.metadata || data.meta || {
      title: data.title,
      description: data.description,
      author: data.author,
      publishedDate: data.publishedDate || data.published_at,
      image: data.image,
      siteName: data.siteName || data.site_name,
      domain: data.domain,
    };

    // Ensure domain present
    if (!meta?.domain) {
      try {
        meta.domain = new URL(resUrl).hostname;
      } catch {
        // ignore
      }
    }

    return {
      url: resUrl,
      redirectedTo,
      html,
      metadata: meta,
    };
  } finally {
    clearTimeout(to);
  }
}
