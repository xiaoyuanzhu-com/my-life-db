import { NextRequest, NextResponse } from 'next/server';
import { getQdrantClient } from '@/lib/search/qdrant-client';
import { embedText } from '@/lib/ai/embeddings';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SemanticSearchAPI' });

export interface SemanticSearchRequest {
  query: string;
  limit?: number;
  scoreThreshold?: number;
  contentType?: string | string[];
  sourceType?: string | string[];
  filePath?: string;
}

export interface SemanticSearchHit {
  id: string;
  score: number;
  payload: {
    // File reference
    filePath: string;
    sourceType: 'content' | 'summary' | 'tags';
    contentType: 'url' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'mixed';

    // Chunk metadata
    chunkIndex: number;
    chunkCount: number;
    text: string; // Chunk text

    // Span tracking
    spanStart: number;
    spanEnd: number;
    overlapTokens: number;

    // Statistics
    wordCount: number;
    tokenCount: number;

    // Additional metadata
    [key: string]: unknown;
  };
}

export interface SemanticSearchResponse {
  results: SemanticSearchHit[];
  query: string;
  limit: number;
  scoreThreshold: number;
}

/**
 * POST /api/search/semantic
 *
 * Performs semantic (vector) search using Qdrant
 *
 * Request body:
 * {
 *   "query": "search terms",
 *   "limit": 20,
 *   "scoreThreshold": 0.7,
 *   "contentType": "url" | ["url", "text"],
 *   "sourceType": "content" | ["content", "summary"],
 *   "filePath": "inbox/article.md"
 * }
 *
 * Response:
 * {
 *   "results": [...],
 *   "query": "search terms",
 *   "limit": 20,
 *   "scoreThreshold": 0.7
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SemanticSearchRequest;

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
    const scoreThreshold = body.scoreThreshold ?? 0.7;

    // Build filter for Qdrant
    const filter: Record<string, unknown> = {};

    // Content type filter
    if (body.contentType) {
      const types = Array.isArray(body.contentType) ? body.contentType : [body.contentType];
      if (types.length === 1) {
        filter.must = filter.must || [];
        (filter.must as Array<unknown>).push({
          key: 'contentType',
          match: { value: types[0] },
        });
      } else if (types.length > 1) {
        filter.should = filter.should || [];
        for (const type of types) {
          (filter.should as Array<unknown>).push({
            key: 'contentType',
            match: { value: type },
          });
        }
      }
    }

    // Source type filter
    if (body.sourceType) {
      const types = Array.isArray(body.sourceType) ? body.sourceType : [body.sourceType];
      if (types.length === 1) {
        filter.must = filter.must || [];
        (filter.must as Array<unknown>).push({
          key: 'sourceType',
          match: { value: types[0] },
        });
      } else if (types.length > 1) {
        filter.should = filter.should || [];
        for (const type of types) {
          (filter.should as Array<unknown>).push({
            key: 'sourceType',
            match: { value: type },
          });
        }
      }
    }

    // File path filter (exact match)
    if (body.filePath) {
      filter.must = filter.must || [];
      (filter.must as Array<unknown>).push({
        key: 'filePath',
        match: { value: body.filePath },
      });
    }

    // Generate query embedding
    log.info({ query }, 'generating query embedding');
    const queryEmbedding = await embedText(query);

    // Get Qdrant client
    const client = getQdrantClient();

    // Perform vector search
    const searchResult = (await client.search({
      vector: queryEmbedding.vector,
      limit,
      scoreThreshold,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      withPayload: true,
    })) as { result: SemanticSearchHit[] };

    const results = searchResult.result || [];

    log.info(
      {
        query,
        limit,
        scoreThreshold,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        hits: results.length,
      },
      'semantic search completed'
    );

    const response: SemanticSearchResponse = {
      results,
      query,
      limit,
      scoreThreshold,
    };

    return NextResponse.json(response);
  } catch (error) {
    log.error({ err: error }, 'semantic search failed');

    // Handle Qdrant-specific errors
    const errorMessage = error instanceof Error ? error.message : 'unknown error';

    if (errorMessage.includes('QDRANT_URL is not configured')) {
      return NextResponse.json(
        { error: 'Qdrant is not configured' },
        { status: 503 }
      );
    }

    if (errorMessage.includes('collection') && errorMessage.includes('not found')) {
      return NextResponse.json(
        { error: 'Vector collection not found' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error', details: errorMessage },
      { status: 500 }
    );
  }
}
