/**
 * Slug Digester
 * Generates friendly URL slugs from content
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { callOpenAICompletion } from '~/lib/vendors/openai';
import { getLogger } from '~/lib/log/logger';
import { generateSlug } from '~/lib/utils/slug';
import {
  getPrimaryTextContent,
  getSummaryText,
  getUrlCrawlMarkdown,
} from '~/lib/digest/text-source';

const log = getLogger({ module: 'SlugDigester' });
const MAX_TEXT_CHARS = 4000;
const MAX_MARKDOWN_CHARS = 6000;

type ParsedSlugResponse = {
  title?: string;
  slug?: string;
};

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function parseJsonFromResponse(content: string): ParsedSlugResponse | null {
  const attempts: Array<() => unknown> = [
    () => JSON.parse(content),
    () => {
      const markdownJsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (markdownJsonMatch) {
        return JSON.parse(markdownJsonMatch[1]);
      }
      return null;
    },
    () => {
      const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) {
        return JSON.parse(jsonObjectMatch[0]);
      }
      return null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const parsed = attempt();
      if (parsed && typeof parsed === 'object') {
        return parsed as ParsedSlugResponse;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractSlugPayload(content: string): ParsedSlugResponse {
  const parsed = parseJsonFromResponse(content);
  if (parsed) {
    return parsed;
  }

  // Fallback: treat first line as title
  const fallbackTitle = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
  if (fallbackTitle) {
    return { title: fallbackTitle };
  }

  return {};
}

/**
 * Slug Digester
 * Generates slugs from summary (preferred) or content (fallback)
 *
 * Always runs for all file types. Completes with slug if text available,
 * completes with null content if no text available (never skips).
 * Cascading resets from upstream digesters trigger re-processing.
 */
export class SlugDigester implements Digester {
  readonly name = 'slug';
  readonly label = 'Slug';
  readonly description = 'Generate friendly URL slugs for file naming';

  async canDigest(
    _filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Always try to run for non-folder files
    // Cascading resets handle re-processing when content becomes available
    return !file.is_folder;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    const now = new Date().toISOString();

    const summaryText = getSummaryText(existingDigests);
    const primaryTextSource = await getPrimaryTextContent(filePath, file, existingDigests);
    const urlMarkdown = getUrlCrawlMarkdown(existingDigests);

    const primaryText = primaryTextSource?.text || summaryText || urlMarkdown;
    const sourceType = primaryTextSource?.source || (summaryText ? 'summary' : urlMarkdown ? 'url-digest' : 'unknown');

    if (!primaryText) {
      // No text available - complete with no content (don't skip)
      // Cascading resets will trigger re-processing if content becomes available
      log.debug({ filePath }, 'no text content available for slug');
      return [
        {
          filePath,
          digester: 'slug',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    const truncatedPrimary = truncateText(primaryText, MAX_TEXT_CHARS);
    const truncatedUrlMarkdown =
      urlMarkdown && urlMarkdown !== primaryText ? truncateText(urlMarkdown, MAX_MARKDOWN_CHARS) : null;

    log.debug(
      {
        filePath,
        sourceType,
        primaryLength: primaryText.length,
        urlMarkdownLength: urlMarkdown?.length ?? null,
      },
      'generating slug with llm'
    );

    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 80 },
        slug: { type: 'string', minLength: 3, maxLength: 80 },
      },
      required: ['title'],
      additionalProperties: false,
    };

    const promptSections = [
      'Create a concise, memorable file name for this content.',
      'Return 3-5 English words that help the user recall the content.',
      'Output JSON with keys "title" (human-friendly) and "slug" (lowercase ASCII words separated by hyphens).',
      'Avoid quotes, numbering, or prefixes. Prefer nouns/verbs over filler words.',
    ];

    if (summaryText) {
      promptSections.push(`Summary:\n${truncateText(summaryText, MAX_TEXT_CHARS)}`);
    }

    promptSections.push(
      `Primary text (${primaryText.length} chars, truncated if noted):\n${truncatedPrimary}`
    );

    if (truncatedUrlMarkdown) {
      promptSections.push(
        `Crawled markdown (${urlMarkdown!.length} chars, truncated if noted):\n${truncatedUrlMarkdown}`
      );
    }

    const prompt = promptSections.join('\n\n');

    let completionContent: string;
    try {
      const completion = await callOpenAICompletion({
        systemPrompt: 'You are a concise file-naming assistant. Respond with short, descriptive English names.',
        prompt,
        jsonSchema: schema,
        temperature: 0.2,
      });
      completionContent = completion.content;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const llmContext = {
        sourceType,
        primaryLength: primaryText.length,
        urlMarkdownLength: urlMarkdown?.length ?? null,
        promptPreview: prompt.slice(0, 500),
      };
      Object.assign(err, { llmContext });
      log.error(
        {
          filePath,
          ...llmContext,
          error: err.message,
        },
        'slug generation failed'
      );
      throw err;
    }

    const parsed = extractSlugPayload(completionContent);
    const candidateTitle = (parsed.title || parsed.slug || '').trim();
    const fallbackTitle = (summaryText || primaryText || 'untitled').trim();
    const title = candidateTitle.length > 0 ? candidateTitle : fallbackTitle;

    const candidateSlug = (parsed.slug || parsed.title || title).trim();
    let slug = generateSlug(candidateSlug);
    if (!slug) {
      slug = generateSlug(title);
    }
    if (!slug) {
      slug = `note-${Date.now().toString(36)}`;
      log.warn({ filePath }, 'slug empty after normalization, using fallback');
    }

    // Create slug digest with metadata
    const slugData = {
      slug,
      title,
      source: 'llm',
      generatedFrom: sourceType,
      generatedAt: now,
    };

    log.debug({ filePath, slug, title }, 'slug generated');

    return [
      {
        filePath,
        digester: 'slug',
        status: 'completed',
        content: JSON.stringify(slugData),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
