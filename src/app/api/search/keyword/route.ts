import { NextRequest, NextResponse } from 'next/server';
import { getMeiliClient } from '@/lib/search/meili-client';
import { getLogger } from '@/lib/log/logger';
import type { MeiliSearchPayload } from '@/lib/search/meili-tasks';

const log = getLogger({ module: 'KeywordSearchAPI' });

/**
 * Escape special characters in Meilisearch filter values
 * Prevents filter injection attacks
 */
function escapeFilterValue(value: string): string {
  // Escape double quotes and backslashes
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface KeywordSearchRequest {
  query: string;
  limit?: number;
  offset?: number;
  mimeType?: string | string[];
  filePath?: string;
}

export interface KeywordSearchResult {
  documentId: string;
  filePath: string;
  mimeType: string | null;
  content: string;
  summary: string | null;
  tags: string | null;
  contentHash: string;
  wordCount: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Meilisearch-specific fields
  _formatted?: Partial<MeiliSearchPayload>;
}

export interface KeywordSearchResponse {
  results: KeywordSearchResult[];
  query: string;
  total: number;
  limit: number;
  offset: number;
  processingTimeMs: number;
}

/**
 * POST /api/search/keyword
 *
 * Performs keyword search using Meilisearch (BM25 algorithm)
 *
 * Request body:
 * {
 *   "query": "search terms",
 *   "limit": 20,
 *   "offset": 0,
 *   "mimeType": "text/markdown" | ["text/markdown", "text/plain"],
 *   "filePath": "inbox/article.md"
 * }
 *
 * Response:
 * {
 *   "results": [...],
 *   "query": "search terms",
 *   "total": 42,
 *   "limit": 20,
 *   "offset": 0,
 *   "processingTimeMs": 15
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as KeywordSearchRequest;

    // Validate query
    if (!body.query || typeof body.query !== 'string') {
      return NextResponse.json(
        { error: 'query is required and must be a string' },
        { status: 400 }
      );
    }

    const query = body.query.trim();
    if (query.length === 0) {
      return NextResponse.json(
        { error: 'query cannot be empty' },
        { status: 400 }
      );
    }

    // Parse options
    const limit = Math.min(body.limit ?? 20, 100); // Cap at 100
    const offset = body.offset ?? 0;

    // Build filter expression
    const filters: string[] = [];

    // MIME type filter
    if (body.mimeType) {
      const types = Array.isArray(body.mimeType) ? body.mimeType : [body.mimeType];
      if (types.length === 1) {
        filters.push(`mimeType = "${escapeFilterValue(types[0])}"`);
      } else if (types.length > 1) {
        filters.push(`mimeType IN [${types.map(t => `"${escapeFilterValue(t)}"`).join(', ')}]`);
      }
    }

    // File path filter (exact match)
    if (body.filePath) {
      filters.push(`filePath = "${escapeFilterValue(body.filePath)}"`);
    }

    const filter = filters.length > 0 ? filters.join(' AND ') : undefined;

    // Get Meilisearch client
    const client = await getMeiliClient();

    // Perform search
    const searchResult = await client.search<KeywordSearchResult>(query, {
      limit,
      offset,
      filter,
      attributesToHighlight: ['content', 'summary', 'tags'],
      attributesToCrop: ['content'],
      cropLength: 300,
    });

    log.info(
      {
        query,
        limit,
        offset,
        filter,
        hits: searchResult.hits.length,
        total: searchResult.estimatedTotalHits,
        processingTimeMs: searchResult.processingTimeMs,
      },
      'keyword search completed'
    );

    const response: KeywordSearchResponse = {
      results: searchResult.hits,
      query: searchResult.query,
      total: searchResult.estimatedTotalHits,
      limit: searchResult.limit,
      offset: searchResult.offset,
      processingTimeMs: searchResult.processingTimeMs,
    };

    return NextResponse.json(response);
  } catch (error) {
    log.error({ err: error }, 'keyword search failed');

    // Handle Meilisearch-specific errors
    const errorMessage = error instanceof Error ? error.message : 'unknown error';

    if (errorMessage.includes('MEILI_HOST is not configured')) {
      return NextResponse.json(
        { error: 'Meilisearch is not configured' },
        { status: 503 }
      );
    }

    if (errorMessage.includes('404')) {
      return NextResponse.json(
        { error: 'Search index not found' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error', details: errorMessage },
      { status: 500 }
    );
  }
}
