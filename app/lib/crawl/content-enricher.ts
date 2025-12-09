/**
 * Content Enricher - Convert HTML to Markdown and clean content
 */

export interface ProcessedContent {
  markdown: string;
  cleanText: string;
  wordCount: number;
  readingTimeMinutes: number;
}

/**
 * Process HTML content into various formats
 */
export function processHtmlContent(
  html: string,
  options: { wordsPerMinute?: number } = {}
): ProcessedContent {
  const { wordsPerMinute = 200 } = options;

  // Convert to markdown
  const markdown = htmlToMarkdown(html);

  // Extract clean text
  const cleanText = extractCleanText(html);

  // Calculate stats
  const wordCount = cleanText.split(/\s+/).filter(w => w.length > 0).length;
  const readingTimeMinutes = Math.ceil(wordCount / wordsPerMinute);

  return {
    markdown,
    cleanText,
    wordCount,
    readingTimeMinutes,
  };
}

/**
 * Convert HTML to Markdown (basic implementation)
 * For more advanced conversion, consider using a library like turndown
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script and style tags
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  md = md.replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n');

  // Convert paragraphs
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n');

  // Convert line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Convert links
  md = md.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Convert images
  md = md.replace(/<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]+alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, '![$1]($2)');
  md = md.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, '![]($1)');

  // Convert bold
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');

  // Convert italic
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*');

  // Convert code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // Convert inline code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Convert blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const lines = content.trim().split('\n');
    return '\n' + lines.map((line: string) => `> ${line}`).join('\n') + '\n';
  });

  // Convert unordered lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    const list = content.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
    return '\n' + list + '\n';
  });

  // Convert ordered lists
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    let counter = 1;
    const list = content.replace(/<li[^>]*>(.*?)<\/li>/gi, () => {
      return `${counter++}. $1\n`;
    });
    return '\n' + list + '\n';
  });

  // Convert horizontal rules
  md = md.replace(/<hr[^>]*>/gi, '\n---\n');

  // Remove remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = decodeHtmlEntities(md);

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
  md = md.replace(/[ \t]+/g, ' '); // Normalize spaces
  md = md.trim();

  return md;
}

/**
 * Extract clean text from HTML (more aggressive than markdown)
 */
function extractCleanText(html: string): string {
  let text = html;

  // Remove script and style tags
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
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
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&lsquo;': "'",
    '&rsquo;': "'",
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
  };

  return text.replace(/&[a-z]+;|&#\d+;/gi, (match) => {
    return entities[match.toLowerCase()] || match;
  });
}

/**
 * Extract main content from HTML (attempt to find article body)
 * This is a simple heuristic - for better results, use a library like Mozilla Readability
 */
export function extractMainContent(html: string): string {
  // Try to find main content containers
  const contentSelectors = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*article[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const selector of contentSelectors) {
    const match = html.match(selector);
    if (match) {
      return match[1];
    }
  }

  // Fallback: return everything in body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

/**
 * Sanitize content by removing common noise elements
 */
export function sanitizeContent(html: string): string {
  let clean = html;

  // Remove common noise elements
  clean = clean.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  clean = clean.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  clean = clean.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  clean = clean.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  clean = clean.replace(/<div[^>]*class=["'][^"']*sidebar[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
  clean = clean.replace(/<div[^>]*class=["'][^"']*ad[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

  return clean;
}
