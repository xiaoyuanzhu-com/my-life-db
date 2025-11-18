import { NextRequest, NextResponse } from 'next/server';
import { getMeiliClient } from '@/lib/search/meili-client';
import { getFileWithDigests } from '@/lib/db/files-with-digests';
import { getLogger } from '@/lib/log/logger';
import { readPrimaryText } from '@/lib/inbox/digest-artifacts';
import type { FileWithDigests } from '@/types/file-card';

const log = getLogger({ module: 'SearchAPI' });

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

    if (query.length > 200) {
      return NextResponse.json(
        { error: 'Query must be at most 200 characters', code: 'QUERY_TOO_LONG' },
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

    // Perform Meilisearch query
    const searchStart = Date.now();
    const client = await getMeiliClient();

    const searchResult = await client.search<{
      documentId: string;
      filePath: string;
      mimeType: string | null;
      content: string;
      summary: string | null;
      tags: string | null;
      _formatted?: {
        content?: string;
        summary?: string;
      };
    }>(query, {
      limit,
      offset,
      filter,
      attributesToHighlight: ['content', 'summary'],
      attributesToCrop: ['content'],
      cropLength: 200,
    });

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
        ? hit.content.trim().slice(0, 500)
        : undefined;
      const textPreview = primaryText
        ? primaryText.slice(0, 500)
        : fallbackPreview;

      // Generate snippet from highlighted content or original content
      const snippet = hit._formatted?.content || hit.content.slice(0, 200) + '...';

      results.push({
        ...fileWithDigests,
        textPreview,
        score: 1.0, // Meilisearch doesn't provide a normalized score, so we use 1.0
        snippet,
        highlights: hit._formatted,
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
