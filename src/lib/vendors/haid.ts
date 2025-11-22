import 'server-only';
import { getSettings } from '@/lib/config/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'VendorHAID' });
const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
const DEFAULT_BASE_URL = 'http://172.16.2.11:3003';
const DEFAULT_CHROME_CDP_URL = 'http://172.16.2.2:9223/';

export interface HaidEmbeddingOptions {
  texts: string[];
  model?: string;
}

export interface HaidEmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface HaidCrawlOptions {
  url: string;
  screenshot?: boolean;
  timeoutMs?: number;
  pageTimeout?: number;
}

export interface HaidCrawlMetadata {
  title?: string;
  description?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  siteName?: string;
  domain?: string;
}

export interface HaidCrawlResponse {
  url: string;
  redirectedTo?: string | null;
  html?: string | null;
  markdown?: string | null;
  metadata?: HaidCrawlMetadata;
  screenshot?: {
    base64: string;
    mimeType: string;
  } | null;
}

export async function crawlUrlWithHaid(
  options: HaidCrawlOptions
): Promise<HaidCrawlResponse> {
  if (!options.url) {
    throw new Error('crawlUrlWithHaid requires a URL');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/crawl`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      url: options.url,
      screenshot: options.screenshot ?? true,
      screenshot_fullpage: false,
      screenshot_width: 1920,
      screenshot_height: 1080,
      page_timeout: options.pageTimeout ?? 120000,
      chrome_cdp_url: config.chromeCdpUrl,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HAID crawl error (${response.status}): ${errorText || response.statusText}`);
  }

  // Check if response is actually JSON
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const responseText = await response.text();
    log.error({
      endpoint,
      contentType,
      responsePreview: responseText.substring(0, 200)
    }, 'HAID returned non-JSON response');
    throw new Error(`HAID returned ${contentType || 'unknown'} instead of JSON. Response: ${responseText.substring(0, 200)}`);
  }

  const data = await response.json();

  const result = {
    url: data.url ?? options.url,
    redirectedTo: data.redirectedTo ?? data.redirect_url ?? null,
    html: data.html ?? null,
    markdown: data.markdown ?? data.text ?? null,
    metadata: normalizeMetadata(data),
    screenshot: normalizeScreenshot(data),
  };

  log.info({
    url: options.url,
    hasHtml: Boolean(result.html),
    hasMarkdown: Boolean(result.markdown),
    hasScreenshot: Boolean(result.screenshot),
    screenshotKeys: data.screenshot ? Object.keys(data.screenshot) : null,
  }, 'crawl response processed');

  return result;
}

export async function callHaidEmbedding(
  options: HaidEmbeddingOptions
): Promise<HaidEmbeddingResponse> {
  if (!options.texts || options.texts.length === 0) {
    throw new Error('HAID embedding requires at least one text');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/text-to-embedding`;
  const model = options.model || process.env.HAID_EMBEDDING_MODEL || DEFAULT_MODEL;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      texts: options.texts,
      model,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID embedding error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const embeddings = extractEmbeddings(data);
  if (!embeddings.length) {
    throw new Error('HAID embedding response did not include embeddings');
  }

  const dimensions = data.dimensions ?? (embeddings[0] ? embeddings[0].length : 0);

  return {
    embeddings,
    model: data.model ?? model,
    dimensions,
  };
}

function normalizeMetadata(raw: any): HaidCrawlMetadata | undefined {
  if (!raw) return undefined;
  const metadata = raw.metadata ?? {};
  return {
    title: metadata.title ?? raw.title ?? undefined,
    description: metadata.description ?? raw.description ?? undefined,
    author: metadata.author ?? raw.author ?? undefined,
    publishedDate: metadata.publishedDate ?? raw.publishedDate ?? undefined,
    image: metadata.image ?? raw.image ?? undefined,
    siteName: metadata.siteName ?? raw.siteName ?? undefined,
    domain: metadata.domain ?? raw.domain ?? undefined,
  };
}

function normalizeScreenshot(raw: any): HaidCrawlResponse['screenshot'] {
  // HAID API returns screenshot_base64 field directly
  if (typeof raw?.screenshot_base64 === 'string' && raw.screenshot_base64.length > 0) {
    log.debug({ screenshotLength: raw.screenshot_base64.length }, 'screenshot extracted from HAID response');
    return {
      base64: raw.screenshot_base64,
      mimeType: 'image/png',
    };
  }
  log.warn({ hasScreenshotBase64: Boolean(raw?.screenshot_base64), type: typeof raw?.screenshot_base64 }, 'no screenshot_base64 in HAID response');
  return null;
}

function extractEmbeddings(payload: any): number[][] {
  if (Array.isArray(payload?.embeddings)) {
    return payload.embeddings as number[][];
  }

  if (Array.isArray(payload?.vectors)) {
    return payload.vectors as number[][];
  }

  if (Array.isArray(payload?.data)) {
    return payload.data
      .map((item: any) => item?.embedding)
      .filter((embedding: unknown): embedding is number[] => Array.isArray(embedding));
  }

  log.warn({ payload }, 'unable to detect embeddings array in HAID response');
  return [];
}

async function resolveHaidConfig(): Promise<{
  baseUrl: string;
  apiKey?: string;
  chromeCdpUrl?: string;
}> {
  let baseUrl = process.env.HAID_BASE_URL;
  let chromeCdpUrl = process.env.HAID_CHROME_CDP_URL;

  try {
    const settings = await getSettings();
    baseUrl = baseUrl || settings.vendors?.homelabAi?.baseUrl || DEFAULT_BASE_URL;
    chromeCdpUrl = chromeCdpUrl || settings.vendors?.homelabAi?.chromeCdpUrl || DEFAULT_CHROME_CDP_URL;
  } catch (error) {
    log.warn({ err: error }, 'failed to load HAID base URL from settings, using defaults');
    baseUrl = baseUrl || DEFAULT_BASE_URL;
    chromeCdpUrl = chromeCdpUrl || DEFAULT_CHROME_CDP_URL;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: process.env.HAID_API_KEY,
    chromeCdpUrl,
  };
}
