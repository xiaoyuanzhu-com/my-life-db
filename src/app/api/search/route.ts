import { NextRequest, NextResponse } from 'next/server';
import { getMeiliClient } from '@/lib/search/meili-client';
import { getQdrantClient } from '@/lib/search/qdrant-client';
import { embedText } from '@/lib/ai/embeddings';
import { getFileWithDigests } from '@/lib/db/files-with-digests';
import { getLogger } from '@/lib/log/logger';
import { readPrimaryText } from '@/lib/inbox/digest-artifacts';
import type { FileWithDigests } from '@/types/file-card';
import type { DigestSummary } from '@/types/file-card';

const log = getLogger({ module: 'SearchAPI' });
const HIGHLIGHT_PRE_TAG = '<em>';
const HIGHLIGHT_POST_TAG = '</em>';

/**
 * Escape special characters in Meilisearch filter values
 * Prevents filter injection attacks
 */
function escapeFilterValue(value: string): string {
  // Escape double quotes and backslashes
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface SearchResultItem extends FileWithDigests {
  // Search metadata
  score: number;
  snippet: string;
  highlights?: {
    content?: string;
    summary?: string;
    tags?: string;
  };
  matchContext?: {
    source: 'digest' | 'semantic';
    snippet: string;
    terms: string[];
    score?: number; // Similarity score for semantic matches (0.0-1.0)
    sourceType?: string; // Source type for semantic matches (content/summary/tags)
    digest?: {
      type: string;
      label: string;
    };
  };
}

export interface SearchResponse {
  results: SearchResultItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  query: string;
  timing: {
    totalMs: number;
    searchMs: number;
    enrichMs: number;
  };
}

/**
 * GET /api/search
 *
 * Unified search endpoint with Meilisearch (keyword search).
 * Returns file records enriched with digest data.
 *
 * Query parameters:
 * - q: Search query (required, min 2 chars)
 * - limit: Results per page (default: 20, max: 100)
 * - offset: Pagination offset (default: 0)
 * - type: Filter by MIME type prefix (e.g., "text/", "image/")
 * - path: Filter by path prefix (e.g., "notes/", "inbox/")
 *
 * Example:
 * GET /api/search?q=meeting%20notes&limit=20&offset=0&path=notes/
 *
 * Response:
 * {
 *   "results": [...],
 *   "pagination": { "total": 47, "limit": 20, "offset": 0, "hasMore": true },
 *   "query": "meeting notes",
 *   "timing": { "totalMs": 145, "searchMs": 42, "enrichMs": 103 }
 * }
 */
type SearchHit = {
  documentId: string;
  filePath: string;
  mimeType: string | null;
  content: string;
  summary: string | null;
  tags: string | null;
  _formatted?: {
    content?: string;
    summary?: string;
    tags?: string;
  };
  // Semantic search metadata (from Qdrant)
  _semantic?: {
    score: number;
    chunkText: string;
    sourceType: string;
  };
};

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q')?.trim() || '';
    const limit = Math.min(
      parseInt(searchParams.get('limit') || '20', 10),
      100
    );
    const offset = Math.max(
      parseInt(searchParams.get('offset') || '0', 10),
      0
    );
    const typeFilter = searchParams.get('type') || undefined;
    const pathFilter = searchParams.get('path') || undefined;

    // Validate query
    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter "q" is required', code: 'QUERY_REQUIRED' },
        { status: 400 }
      );
    }

    if (query.length < 2) {
      return NextResponse.json(
        { error: 'Query must be at least 2 characters', code: 'QUERY_TOO_SHORT' },
        { status: 400 }
      );
    }

    // Build Meilisearch filter
    const filters: string[] = [];

    if (typeFilter) {
      // Support prefix matching for type (e.g., "text/" matches "text/markdown", "text/plain")
      filters.push(`mimeType STARTS WITH "${escapeFilterValue(typeFilter)}"`);
    }

    if (pathFilter) {
      // Support prefix matching for path (e.g., "notes/" matches all files under notes/)
      filters.push(`filePath STARTS WITH "${escapeFilterValue(pathFilter)}"`);
    }

    const filter = filters.length > 0 ? filters.join(' AND ') : undefined;

    // Count words in query
    const queryWords = query.split(/\s+/).filter(word => word.length > 0);
    const wordCount = queryWords.length;

    // If query has >10 words, use Qdrant (semantic search) only
    // Otherwise use both Meilisearch and Qdrant for better coverage
    const useSemanticOnly = wordCount > 10;

    const searchStart = Date.now();
    const highlightTerms = extractSearchTerms(query);
    let searchResult: { hits: SearchHit[]; estimatedTotalHits: number; limit: number; offset: number; query: string };

    if (useSemanticOnly) {
      // Use Qdrant semantic search only for long queries (>10 words)
      log.info({ query, wordCount }, 'using semantic search only (query >10 words)');

      try {
        const queryEmbedding = await embedText(query);
        const qdrantClient = await getQdrantClient();

        // Build Qdrant filter based on path/type filters
        const qdrantFilter: Record<string, unknown> = {};
        if (typeFilter) {
          qdrantFilter.must = qdrantFilter.must || [];
          (qdrantFilter.must as Array<unknown>).push({
            key: 'mimeType',
            match: { value: typeFilter },
          });
        }
        if (pathFilter) {
          qdrantFilter.must = qdrantFilter.must || [];
          (qdrantFilter.must as Array<unknown>).push({
            key: 'filePath',
            match: { value: pathFilter },
          });
        }

        const qdrantResult = (await qdrantClient.search({
          vector: queryEmbedding.vector,
          limit,
          scoreThreshold: 0.7, // Higher threshold for better precision
          filter: Object.keys(qdrantFilter).length > 0 ? qdrantFilter : undefined,
          withPayload: true,
        })) as { result: Array<{ id: string; score: number; payload: { filePath: string; text: string; sourceType?: string } }> };

        // Convert Qdrant results to SearchHit format
        // Group by filePath to deduplicate chunks
        const filePathMap = new Map<string, SearchHit>();
        for (const hit of qdrantResult.result || []) {
          const filePath = hit.payload.filePath;
          if (!filePathMap.has(filePath)) {
            filePathMap.set(filePath, {
              documentId: hit.id,
              filePath,
              mimeType: null, // Will be filled from files table
              content: hit.payload.text,
              summary: null,
              tags: null,
              _semantic: {
                score: hit.score,
                chunkText: hit.payload.text,
                sourceType: hit.payload.sourceType || 'content',
              },
            });
          }
        }

        searchResult = {
          hits: Array.from(filePathMap.values()).slice(offset, offset + limit),
          estimatedTotalHits: filePathMap.size,
          limit,
          offset,
          query,
        };
      } catch (error) {
        log.warn({ err: error }, 'qdrant search failed, falling back to meilisearch');
        // Fall back to Meilisearch if Qdrant fails
        const client = await getMeiliClient();
        searchResult = await client.search<SearchHit>(query, {
          limit,
          offset,
          filter,
          attributesToHighlight: ['content', 'summary', 'tags'],
          attributesToCrop: ['content'],
          cropLength: 200,
          matchingStrategy: 'all',
        });
      }
    } else {
      // Use both Meilisearch and Qdrant for short queries (<=10 words)
      log.info({ query, wordCount }, 'using hybrid search (meili + qdrant)');

      try {
        // Fetch from both sources in parallel
        const [meiliResult, qdrantHits] = await Promise.all([
          // Meilisearch keyword search
          (async () => {
            const client = await getMeiliClient();
            return client.search<SearchHit>(query, {
              limit: limit * 2, // Fetch more for merging
              offset: 0, // Always from beginning for merging
              filter,
              attributesToHighlight: ['content', 'summary', 'tags'],
              attributesToCrop: ['content'],
              cropLength: 200,
              matchingStrategy: 'all',
            });
          })(),
          // Qdrant semantic search
          (async () => {
            try {
              const queryEmbedding = await embedText(query);
              const qdrantClient = await getQdrantClient();

              const qdrantFilter: Record<string, unknown> = {};
              if (typeFilter) {
                qdrantFilter.must = qdrantFilter.must || [];
                (qdrantFilter.must as Array<unknown>).push({
                  key: 'mimeType',
                  match: { value: typeFilter },
                });
              }
              if (pathFilter) {
                qdrantFilter.must = qdrantFilter.must || [];
                (qdrantFilter.must as Array<unknown>).push({
                  key: 'filePath',
                  match: { value: pathFilter },
                });
              }

              const qdrantResult = (await qdrantClient.search({
                vector: queryEmbedding.vector,
                limit: limit * 2, // Fetch more for merging
                scoreThreshold: 0.7, // Higher threshold for better precision
                filter: Object.keys(qdrantFilter).length > 0 ? qdrantFilter : undefined,
                withPayload: true,
              })) as { result: Array<{ id: string; score: number; payload: { filePath: string; text: string; sourceType?: string } }> };

              return qdrantResult.result || [];
            } catch (error) {
              log.warn({ err: error }, 'qdrant search failed in hybrid mode');
              return [];
            }
          })(),
        ]);

        // Merge results using a simple file-path-based deduplication
        // Prioritize Meilisearch results (better for keyword matching)
        const filePathMap = new Map<string, SearchHit>();

        // Add Meilisearch results first (with highlights and formatting)
        for (const hit of meiliResult.hits) {
          filePathMap.set(hit.filePath, hit);
        }

        // Add Qdrant results that aren't already in Meilisearch
        for (const hit of qdrantHits) {
          const filePath = hit.payload.filePath;
          if (!filePathMap.has(filePath)) {
            filePathMap.set(filePath, {
              documentId: hit.id,
              filePath,
              mimeType: null,
              content: hit.payload.text,
              summary: null,
              tags: null,
              _semantic: {
                score: hit.score,
                chunkText: hit.payload.text,
                sourceType: hit.payload.sourceType || 'content',
              },
            });
          }
        }

        // Convert to array and apply pagination
        const mergedHits = Array.from(filePathMap.values());
        const paginatedHits = mergedHits.slice(offset, offset + limit);

        searchResult = {
          hits: paginatedHits,
          estimatedTotalHits: mergedHits.length,
          limit,
          offset,
          query,
        };

        log.info(
          {
            query,
            meiliCount: meiliResult.hits.length,
            qdrantCount: qdrantHits.length,
            mergedCount: mergedHits.length,
            returnedCount: paginatedHits.length,
          },
          'hybrid search merged'
        );
      } catch (error) {
        log.warn({ err: error }, 'hybrid search failed, falling back to meilisearch only');
        // Fall back to Meilisearch only if hybrid fails
        const client = await getMeiliClient();
        searchResult = await client.search<SearchHit>(query, {
          limit,
          offset,
          filter,
          attributesToHighlight: ['content', 'summary', 'tags'],
          attributesToCrop: ['content'],
          cropLength: 200,
          matchingStrategy: 'all',
        });
      }
    }

    const searchMs = Date.now() - searchStart;

    // Enrich results with file metadata and digests
    const enrichStart = Date.now();
    const results: SearchResultItem[] = [];

    for (const hit of searchResult.hits) {
      // Get file with digests
      const fileWithDigests = getFileWithDigests(hit.filePath);

      if (!fileWithDigests) {
        // File not in files table (might have been deleted)
        log.warn({ filePath: hit.filePath }, 'search result not found in files table');
        continue;
      }

      const primaryText = await readPrimaryText(fileWithDigests.path);
      const fallbackPreview = hit.content.trim().length > 0
        ? hit.content.trim().split('\n').slice(0, 60).join('\n')
        : undefined;
      const textPreview = primaryText
        ? primaryText.split('\n').slice(0, 60).join('\n')
        : fallbackPreview;

      // Generate snippet from highlighted content or original content
      const snippet = hit._formatted?.content || hit.content.slice(0, 200) + '...';
      const primaryContainsTerm = primaryText
        ? containsAnyTerm(primaryText, highlightTerms)
        : false;

      // Build match context - prefer semantic if available, otherwise try digest
      let matchContext: SearchResultItem['matchContext'] | undefined;
      if (hit._semantic) {
        // Semantic search result - show the matched chunk
        matchContext = buildSemanticMatchContext({
          semantic: hit._semantic,
          terms: highlightTerms,
        });
      } else if (!primaryContainsTerm) {
        // Keyword search result without primary match - check digests
        matchContext = buildDigestMatchContext({
          hit,
          file: fileWithDigests,
          terms: highlightTerms,
          primaryContainsTerm,
        });
      }

      results.push({
        ...fileWithDigests,
        textPreview,
        score: 1.0, // Meilisearch doesn't provide a normalized score, so we use 1.0
        snippet,
        highlights: hit._formatted,
        matchContext,
      });
    }

    const enrichMs = Date.now() - enrichStart;
    const totalMs = Date.now() - startTime;

    const response: SearchResponse = {
      results,
      pagination: {
        total: searchResult.estimatedTotalHits,
        limit: searchResult.limit,
        offset: searchResult.offset,
        hasMore: searchResult.offset + searchResult.hits.length < searchResult.estimatedTotalHits,
      },
      query: searchResult.query,
      timing: {
        totalMs,
        searchMs,
        enrichMs,
      },
    };

    log.info(
      {
        query,
        limit,
        offset,
        filter,
        resultsCount: results.length,
        total: searchResult.estimatedTotalHits,
        totalMs,
        searchMs,
        enrichMs,
      },
      'search completed'
    );

    return NextResponse.json(response);
  } catch (error) {
    log.error({ err: error }, 'search failed');

    const errorMessage = error instanceof Error ? error.message : 'unknown error';

    // Handle Meilisearch-specific errors
    if (errorMessage.includes('MEILI_HOST is not configured')) {
      return NextResponse.json(
        { error: 'Search is not configured', code: 'SEARCH_NOT_CONFIGURED' },
        { status: 503 }
      );
    }

    if (errorMessage.includes('404') || errorMessage.includes('index_not_found')) {
      return NextResponse.json(
        { error: 'Search index not found', code: 'INDEX_NOT_FOUND' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error', details: errorMessage },
      { status: 500 }
    );
  }
}

function extractSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/\s+/)
        .map((term) => term.replace(/^['"]+|['"]+$/g, '').trim())
        .filter((term) => term.length > 0)
    )
  );
}

function hasHighlight(value?: string | null): value is string {
  return Boolean(value && value.includes(HIGHLIGHT_PRE_TAG));
}

const SUMMARY_DIGESTERS = new Set(['summary', 'url-crawl-summary', 'summarize']);
const TAG_DIGESTERS = new Set(['tags']);
const CONTENT_DIGESTERS = new Set(['url-crawl-content', 'content-md', 'url-content-md']);

interface DigestFieldConfig {
  field: 'summary' | 'tags' | 'content';
  digesterTypes: string[];
  label: string;
  requirePrimaryMiss?: boolean;
}

const DIGEST_FIELD_CONFIG: DigestFieldConfig[] = [
  {
    field: 'summary',
    digesterTypes: ['summary', 'url-crawl-summary', 'summarize'],
    label: 'Summary digest',
  },
  {
    field: 'tags',
    digesterTypes: ['tags'],
    label: 'Tags digest',
  },
  {
    field: 'content',
    digesterTypes: ['url-crawl-content', 'content-md', 'url-content-md'],
    label: 'Crawled digest',
    requirePrimaryMiss: true,
  },
];

function buildSemanticMatchContext({
  semantic,
  terms,
}: {
  semantic: { score: number; chunkText: string; sourceType: string };
  terms: string[];
}): SearchResultItem['matchContext'] | undefined {
  const { score, chunkText, sourceType } = semantic;

  // Truncate chunk text if too long
  const maxLength = 300;
  const snippet = chunkText.length > maxLength
    ? chunkText.slice(0, maxLength).trim() + '...'
    : chunkText;

  // Map sourceType to human-readable label
  const sourceLabels: Record<string, string> = {
    content: 'File content',
    summary: 'Summary',
    tags: 'Tags',
  };

  return {
    source: 'semantic',
    snippet,
    terms,
    score,
    sourceType: sourceLabels[sourceType] || sourceType,
  };
}

/**
 * Extract a snippet from Meilisearch's formatted text with <em> highlights.
 * Finds the first highlight and extracts context around it.
 * This preserves fuzzy matches (e.g., "docube" → "<em>Docume</em>ntation").
 */
function extractSnippetFromFormatted(formattedText: string, maxLength = 200): string {
  // Find the first <em> tag position
  const highlightStart = formattedText.indexOf(HIGHLIGHT_PRE_TAG);
  if (highlightStart === -1) {
    return formattedText.slice(0, maxLength);
  }

  // Calculate context window around the highlight
  const contextRadius = 80;
  const start = Math.max(0, highlightStart - contextRadius);
  const end = Math.min(formattedText.length, highlightStart + contextRadius + 100);

  let snippet = formattedText.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) {
    snippet = '...' + snippet;
  }
  if (end < formattedText.length) {
    snippet = snippet + '...';
  }

  // Ensure we don't exceed max length
  if (snippet.length > maxLength) {
    // Try to preserve at least one complete highlight
    const firstHighlight = snippet.indexOf(HIGHLIGHT_PRE_TAG);
    const highlightEnd = snippet.indexOf(HIGHLIGHT_POST_TAG, firstHighlight);
    if (firstHighlight !== -1 && highlightEnd !== -1) {
      const minLength = highlightEnd + HIGHLIGHT_POST_TAG.length + 20;
      snippet = snippet.slice(0, Math.max(maxLength, minLength)) + '...';
    } else {
      snippet = snippet.slice(0, maxLength) + '...';
    }
  }

  return snippet.trim();
}

function buildDigestMatchContext({
  hit,
  file,
  terms,
  primaryContainsTerm,
}: {
  hit: SearchHit;
  file: FileWithDigests;
  terms: string[];
  primaryContainsTerm: boolean;
}): SearchResultItem['matchContext'] | undefined {
  if (terms.length === 0) {
    return undefined;
  }

  for (const config of DIGEST_FIELD_CONFIG) {
    const formattedValue = hit._formatted?.[config.field];
    if (!hasHighlight(formattedValue)) {
      continue;
    }

    if (config.requirePrimaryMiss && primaryContainsTerm) {
      continue;
    }

    const digest = findDigestByType(file.digests, config.digesterTypes);

    // Use Meilisearch's formatted value with <em> tags for snippet
    // This preserves fuzzy match highlights (e.g., "docube" matching "Docume" in "Documentation")
    const snippet = extractSnippetFromFormatted(formattedValue);

    if (!snippet || !snippet.trim()) {
      continue;
    }

    return {
      source: 'digest',
      snippet,
      terms,
      digest: digest
        ? {
            type: digest.type,
            label: getDigestLabel(digest.type, config.label),
          }
        : {
            type: config.field,
            label: config.label,
          },
    };
  }

  return undefined;
}

function findDigestByType(
  digests: DigestSummary[],
  digesterTypes: string[]
): DigestSummary | undefined {
  return digests.find((digest) => digesterTypes.includes(digest.type));
}


function getDigestLabel(type: string, fallback: string): string {
  if (SUMMARY_DIGESTERS.has(type)) {
    return 'Summary digest';
  }
  if (TAG_DIGESTERS.has(type)) {
    return 'Tags digest';
  }
  if (CONTENT_DIGESTERS.has(type)) {
    return 'Crawled digest';
  }
  return fallback;
}

function containsAnyTerm(text: string, terms: string[]): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

