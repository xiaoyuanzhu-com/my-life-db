/**
 * URL Crawler - Fetch and extract web content
 */

export interface CrawlResult {
  url: string;
  html: string;
  metadata: {
    title?: string;
    description?: string;
    author?: string;
    publishedDate?: string;
    image?: string;
    siteName?: string;
    domain: string;
  };
  text: string; // Plain text extraction
  contentType: string;
  status: number;
  redirectedTo?: string;
}

export interface CrawlOptions {
  timeout?: number; // Timeout in milliseconds (default: 30000)
  followRedirects?: boolean; // Follow redirects (default: true)
  userAgent?: string; // Custom user agent
}

/**
 * Crawl a URL and extract content
 */
export async function crawlUrl(
  url: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const {
    timeout = 30000,
    followRedirects = true,
    userAgent = 'Mozilla/5.0 (compatible; MyLifeDB/1.0; +https://github.com/yourusername/mylifedb)',
  } = options;

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Fetch with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Check status
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Get final URL (after redirects)
    const finalUrl = response.url;
    const redirectedTo = finalUrl !== url ? finalUrl : undefined;

    // Get content type
    const contentType = response.headers.get('content-type') || 'text/html';

    // Only process HTML content
    if (!contentType.includes('text/html')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    // Read HTML
    const html = await response.text();

    // Extract metadata
    const metadata = extractMetadata(html, parsedUrl);

    // Extract plain text
    const text = extractTextFromHtml(html);

    return {
      url,
      html,
      metadata,
      text,
      contentType,
      status: response.status,
      redirectedTo,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }
    throw new Error('Unknown error during crawl');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract metadata from HTML
 */
function extractMetadata(html: string, url: URL): CrawlResult['metadata'] {
  const metadata: CrawlResult['metadata'] = {
    domain: url.hostname,
  };

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // Extract Open Graph metadata
  const ogTitle = extractMetaTag(html, 'og:title');
  const ogDescription = extractMetaTag(html, 'og:description');
  const ogImage = extractMetaTag(html, 'og:image');
  const ogSiteName = extractMetaTag(html, 'og:site_name');

  // Extract Twitter Card metadata
  const twitterTitle = extractMetaTag(html, 'twitter:title');
  const twitterDescription = extractMetaTag(html, 'twitter:description');
  const twitterImage = extractMetaTag(html, 'twitter:image');

  // Extract standard meta tags
  const metaDescription = extractMetaTag(html, 'description');
  const metaAuthor = extractMetaTag(html, 'author');

  // Extract article metadata
  const articleAuthor = extractMetaTag(html, 'article:author');
  const articlePublished = extractMetaTag(html, 'article:published_time');

  // Prefer OG/Twitter over standard meta
  metadata.title = ogTitle || twitterTitle || metadata.title;
  metadata.description = ogDescription || twitterDescription || metaDescription;
  metadata.image = ogImage || twitterImage;
  metadata.siteName = ogSiteName || url.hostname;
  metadata.author = articleAuthor || metaAuthor;
  metadata.publishedDate = articlePublished;

  return metadata;
}

/**
 * Extract meta tag content
 */
function extractMetaTag(html: string, name: string): string | undefined {
  // Try property attribute (OG/Twitter)
  const propertyMatch = html.match(
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')
  );
  if (propertyMatch) {
    return decodeHtmlEntities(propertyMatch[1].trim());
  }

  // Try name attribute
  const nameMatch = html.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')
  );
  if (nameMatch) {
    return decodeHtmlEntities(nameMatch[1].trim());
  }

  return undefined;
}

/**
 * Extract plain text from HTML (simple approach)
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
  };

  return text.replace(/&[a-z]+;|&#\d+;/gi, (match) => {
    return entities[match.toLowerCase()] || match;
  });
}

/**
 * Estimate reading time from text
 */
export function estimateReadingTime(text: string, wordsPerMinute: number = 200): number {
  const wordCount = text.split(/\s+/).length;
  return Math.ceil(wordCount / wordsPerMinute);
}
