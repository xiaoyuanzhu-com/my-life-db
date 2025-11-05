import 'server-only';

import { generateSlug } from '@/lib/utils/slug';
import { extractKeywordsForSlug } from '@/lib/crawl/urlSlugGenerator';

export type ContentSlugSource = 'heading' | 'line' | 'keywords';

export interface ContentSlugResult {
  slug: string;
  title: string;
  source: ContentSlugSource;
}

function cleanupText(input: string): string {
  return input
    .replace(/[*_`~]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeTitleCandidate(candidate: string | null): string | null {
  if (!candidate) return null;
  const cleaned = cleanupText(candidate);
  if (cleaned.length < 3) return null;
  return cleaned;
}

export function generateSlugFromContentDigest(text: string): ContentSlugResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot generate slug from empty content');
  }

  const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/m);
  const heading = normalizeTitleCandidate(headingMatch ? headingMatch[1] : null);
  if (heading) {
    return {
      slug: generateSlug(heading),
      title: heading,
      source: 'heading',
    };
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*+]\s+/, '').trim())
    .filter(line => line.length > 0);

  if (lines.length > 0) {
    const firstLine = normalizeTitleCandidate(lines[0]);
    if (firstLine) {
      const slug = generateSlug(firstLine);
      if (slug.length > 0) {
        return {
          slug,
          title: firstLine,
          source: 'line',
        };
      }
    }
  }

  const keywordsSlug = extractKeywordsForSlug(trimmed, 5);
  if (keywordsSlug.length > 0) {
    return {
      slug: keywordsSlug,
      title: keywordsSlug.replace(/-/g, ' '),
      source: 'keywords',
    };
  }

  throw new Error('Failed to derive slug from content');
}
