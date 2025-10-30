/**
 * URL Slug Generator - Generate human-readable slugs for URLs
 */

import { callAI, isAIAvailable } from '../ai/provider';
import { generateSlug } from '../utils/slug';
import type { CrawlResult } from './urlCrawler';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SlugGenerator' });

export interface SlugGenerationResult {
  slug: string;
  title: string;
  source: 'ai' | 'metadata' | 'url' | 'fallback';
}

/**
 * Generate a slug for a URL using AI or fallback methods
 */
export async function generateUrlSlug(
  crawlResult: CrawlResult
): Promise<SlugGenerationResult> {
  // Try AI generation first (if available)
  if (await isAIAvailable()) {
    try {
      const aiResult = await generateSlugWithAI(crawlResult);
      if (aiResult) {
        return {
          slug: generateSlug(aiResult),
          title: aiResult,
          source: 'ai',
        };
      }
    } catch (error) {
      log.warn({ err: error }, 'ai generation failed');
      // Fall through to fallback methods
    }
  }

  // Fallback 1: Use metadata title
  if (crawlResult.metadata.title) {
    return {
      slug: generateSlug(crawlResult.metadata.title),
      title: crawlResult.metadata.title,
      source: 'metadata',
    };
  }

  // Fallback 2: Use URL path
  const urlSlug = generateSlugFromUrl(crawlResult.url);
  if (urlSlug) {
    return {
      slug: urlSlug,
      title: urlSlug.replace(/-/g, ' '),
      source: 'url',
    };
  }

  // Fallback 3: Use domain + timestamp
  const domain = crawlResult.metadata.domain;
  const timestamp = Date.now().toString(36); // Base36 timestamp
  return {
    slug: `${domain}-${timestamp}`,
    title: domain,
    source: 'fallback',
  };
}

/**
 * Generate title and slug using AI
 */
async function generateSlugWithAI(crawlResult: CrawlResult): Promise<string | null> {
  // Prepare content for AI (limit to first 2000 chars)
  const contentPreview = crawlResult.text.slice(0, 2000);

  const prompt = `You are analyzing a web page. Generate a concise, descriptive title (3-6 words) that captures the main topic.

URL: ${crawlResult.url}
Domain: ${crawlResult.metadata.domain}
${crawlResult.metadata.title ? `Page Title: ${crawlResult.metadata.title}` : ''}
${crawlResult.metadata.description ? `Description: ${crawlResult.metadata.description}` : ''}

Content Preview:
${contentPreview}

Instructions:
- Create a concise title (3-6 words)
- Focus on the main topic/subject
- Be specific and descriptive
- Use title case
- Return ONLY the title, nothing else

Title:`;

  const response = await callAI(prompt);
  const title = response.trim();

  // Validate response
  if (!title || title.length < 3 || title.length > 100) {
    return null;
  }

  return title;
}

/**
 * Generate slug from URL path
 */
function generateSlugFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;

    // Remove leading/trailing slashes
    const path = pathname.replace(/^\/+|\/+$/g, '');

    if (!path) {
      return null;
    }

    // Get the last meaningful segment
    const segments = path.split('/').filter(s => s.length > 0);
    const lastSegment = segments[segments.length - 1];

    // Remove file extensions
    const withoutExt = lastSegment.replace(/\.[^.]+$/, '');

    // If the segment looks like a slug already, use it
    if (withoutExt.match(/^[a-z0-9-]+$/i) && withoutExt.length >= 3) {
      return withoutExt;
    }

    // Otherwise, generate slug from the segment
    return generateSlug(withoutExt);
  } catch {
    return null;
  }
}

/**
 * Extract keywords from content for slug generation (fallback)
 */
export function extractKeywordsForSlug(text: string, maxWords: number = 4): string {
  // Remove common stop words
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
    'to', 'was', 'will', 'with', 'the', 'this', 'but', 'they', 'have',
  ]);

  // Extract words
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3 && !stopWords.has(word));

  // Count word frequency
  const frequency = new Map<string, number>();
  words.forEach(word => {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  });

  // Sort by frequency and take top N
  const topWords = Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([word]) => word);

  return generateSlug(topWords.join(' '));
}
