/**
 * HAID (Home AI Daemon) vendor wrapper
 * Placeholder interfaces for URL crawling (docs to be provided later).
 * Keep this layer business-unrelated and aligned to the external service.
 */

import { getSettings } from '@/lib/config/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'HaidClient' });

export interface HaidCrawlOptions {
  url: string;
  timeoutMs?: number;
  screenshot?: boolean; // default: false
  screenshotWidth?: number;
  screenshotHeight?: number;
  pageTimeout?: number;
  chromeCdpUrl?: string;
}

interface NormalizedScreenshot {
  base64: string;
  mimeType: string;
}

export interface HaidCrawlResponse {
  url: string;
  redirectedTo?: string | null;
  html: string;
  markdown?: string;
  title?: string;
  metadata?: {
    title?: string;
    description?: string;
    author?: string;
    publishedDate?: string;
    image?: string;
    siteName?: string;
    domain?: string;
  };
  screenshot?: NormalizedScreenshot | null;
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

  const baseUrl = (vendorConfig?.baseUrl || 'http://172.16.2.11:12310').replace(/\/$/, '');
  const endpointPath = vendorConfig?.endpoints?.webCrawl || '/api/crawl';
  const endpoint = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;

  const chromeCdpUrl = (() => {
    const configured = typeof vendorConfig?.chromeCdpUrl === 'string' ? vendorConfig.chromeCdpUrl.trim() : '';
    const override = typeof options.chromeCdpUrl === 'string' ? options.chromeCdpUrl.trim() : '';
    return override || configured || undefined;
  })();

  const payload: Record<string, unknown> = {
    url: options.url,
    screenshot: options.screenshot ?? false,
  };

  if (typeof options.screenshotWidth === 'number') {
    payload.screenshot_width = options.screenshotWidth;
  }
  if (typeof options.screenshotHeight === 'number') {
    payload.screenshot_height = options.screenshotHeight;
  }
  if (typeof options.pageTimeout === 'number') {
    payload.page_timeout = options.pageTimeout;
  }
  if (chromeCdpUrl) {
    payload.chrome_cdp_url = chromeCdpUrl;
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);

  try {
    log.info(
      {
        endpoint,
        payload,
      },
      'requesting haid crawl'
    );
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, */*',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HAID crawl error ${resp.status}: ${text || resp.statusText}`);
    }

    const data = await parseResponse(resp, options.url);
    const normalized = normalizeResponse(data, options.url);
    log.info(
      {
        url: normalized.url,
        hasHtml: Boolean(normalized.html && normalized.html.length > 0),
        hasMarkdown: Boolean(normalized.markdown && normalized.markdown.length > 0),
        hasScreenshot: Boolean(normalized.screenshot),
      },
      'haid crawl success'
    );
    return normalized;
  } finally {
    clearTimeout(to);
  }
}

async function parseResponse(resp: Response, fallbackUrl: string): Promise<any> {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await resp.json();
  }
  const htmlText = await resp.text();
  return { html: htmlText, url: fallbackUrl };
}

function normalizeResponse(data: any, fallbackUrl: string): HaidCrawlResponse {
  const resUrl = data.url || fallbackUrl;
  const html = data.html || '';
  const markdown = data.markdown || null;
  const title = data.title || undefined;

  const metadata = {
    title,
    description: undefined,
    author: undefined,
    publishedDate: undefined,
    image: undefined,
    siteName: undefined,
    domain: undefined as string | undefined,
  };

  try {
    metadata.domain = new URL(resUrl).hostname;
  } catch {
    metadata.domain = undefined;
  }

  const screenshot = extractScreenshot(data);

  return {
    url: resUrl,
    redirectedTo: null,
    html,
    markdown: markdown ?? undefined,
    title,
    metadata,
    screenshot,
  };
}

function extractScreenshot(data: any): NormalizedScreenshot | null {
  const candidate = data.screenshot_base64;
  if (!candidate || typeof candidate !== 'string') return null;
  return normalizeScreenshotString(candidate, 'image/png');
}

function normalizeScreenshotString(value: string, mimeHint?: string): NormalizedScreenshot | null {
  let base64 = value.trim();
  let mimeType = mimeHint || 'image/png';

  if (base64.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.+)$/.exec(base64);
    if (match) {
      mimeType = match[1];
      base64 = match[2];
    }
  }

  // ensure base64 is valid-ish
  if (!base64 || base64.length < 16) return null;

  return { base64, mimeType };
}
