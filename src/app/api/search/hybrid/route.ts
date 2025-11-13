import { NextRequest, NextResponse } from 'next/server';
import { getMeiliClient } from '@/lib/search/meili-client';
import { getQdrantClient } from '@/lib/search/qdrant-client';
import { embedText } from '@/lib/ai/embeddings';
import { getLogger } from '@/lib/log/logger';
import type { KeywordSearchResult } from '../keyword/route';
import type { SemanticSearchHit } from '../semantic/route';

const log = getLogger({ module: 'HybridSearchAPI' });

/**
 * Escape special characters in Meilisearch filter values
 * Prevents filter injection attacks
 */
function escapeFilterValue(value: string): string {
  // Escape double quotes and backslashes
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface HybridSearchRequest {
  query: string;
  limit?: number;
  keywordWeight?: number; // 0-1, default 0.5
  semanticWeight?: number; // 0-1, default 0.5
  scoreThreshold?: number; // For semantic search, default 0.7
  mimeType?: string | string[];
  filePath?: string;
}

export interface HybridSearchResult {
  // Combined document ID (1:1 with file path)
  documentId: string;
  filePath: string;
  mimeType: string | null;

  // Text content
  content: string;
  summary: string | null;
  tags: string | null;

  // Hybrid score (RRF)
  score: number;

  // Individual scores for transparency
  keywordScore?: number;
  semanticScore?: number;

  // Source indicators
  fromKeyword: boolean;
  fromSemantic: boolean;

  // Additional metadata
  metadata?: Record<string, unknown>;
}

export interface HybridSearchResponse {
  results: HybridSearchResult[];
  query: string;
  limit: number;
  keywordCount: number;
  semanticCount: number;
  hybridCount: number;
}

/**
 * POST /api/search/hybrid
 *
 * Hybrid search combining keyword (Meilisearch) and semantic (Qdrant) results
 * Uses Reciprocal Rank Fusion (RRF) to merge and rerank results
 *
 * Request body:
 * {
 *   "query": "search terms",
 *   "limit": 20,
 *   "keywordWeight": 0.5,
 *   "semanticWeight": 0.5,
 *   "scoreThreshold": 0.7,
 *   "mimeType": "text/markdown" | ["text/markdown", "text/plain"],
 *   "filePath": "inbox/article.md"
 * }
 *
 * Response:
 * {
 *   "results": [...],
 *   "query": "search terms",
 *   "limit": 20,
 *   "keywordCount": 15,
 *   "semanticCount": 18,
 *   "hybridCount": 20
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as HybridSearchRequest;

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
    const keywordWeight = body.keywordWeight ?? 0.5;
    const semanticWeight = body.semanticWeight ?? 0.5;
    const scoreThreshold = body.scoreThreshold ?? 0.7;

    // Fetch results from both systems in parallel
    log.info({ query }, 'fetching keyword and semantic results');

    const [keywordResults, semanticResults] = await Promise.all([
      fetchKeywordResults(query, body, limit),
      fetchSemanticResults(query, body, limit, scoreThreshold),
    ]);

    log.info(
      {
        query,
        keywordCount: keywordResults.length,
        semanticCount: semanticResults.length,
      },
      'fetched search results'
    );

    // Merge results using Reciprocal Rank Fusion (RRF)
    const mergedResults = reciprocalRankFusion(
      keywordResults,
      semanticResults,
      keywordWeight,
      semanticWeight
    );

    // Limit final results
    const finalResults = mergedResults.slice(0, limit);

    log.info(
      {
        query,
        keywordCount: keywordResults.length,
        semanticCount: semanticResults.length,
        hybridCount: finalResults.length,
      },
      'hybrid search completed'
    );

    const response: HybridSearchResponse = {
      results: finalResults,
      query,
      limit,
      keywordCount: keywordResults.length,
      semanticCount: semanticResults.length,
      hybridCount: finalResults.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    log.error({ err: error }, 'hybrid search failed');

    const errorMessage = error instanceof Error ? error.message : 'unknown error';

    return NextResponse.json(
      { error: 'Internal server error', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * Fetch keyword search results from Meilisearch
 */
async function fetchKeywordResults(
  query: string,
  filters: HybridSearchRequest,
  limit: number
): Promise<KeywordSearchResult[]> {
  try {
    const client = await getMeiliClient();

    // Build filter expression
    const filterParts: string[] = [];

    if (filters.mimeType) {
      const types = Array.isArray(filters.mimeType) ? filters.mimeType : [filters.mimeType];
      if (types.length === 1) {
        filterParts.push(`mimeType = "${escapeFilterValue(types[0])}"`);
      } else if (types.length > 1) {
        filterParts.push(`mimeType IN [${types.map(t => `"${escapeFilterValue(t)}"`).join(', ')}]`);
      }
    }


    if (filters.filePath) {
      filterParts.push(`filePath = "${escapeFilterValue(filters.filePath)}"`);
    }

    const filter = filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

    const searchResult = await client.search<KeywordSearchResult>(query, {
      limit: limit * 2, // Fetch more for better merging
      offset: 0,
      filter,
    });

    return searchResult.hits;
  } catch (error) {
    log.warn({ err: error }, 'keyword search failed, continuing with semantic only');
    return [];
  }
}

/**
 * Fetch semantic search results from Qdrant
 */
async function fetchSemanticResults(
  query: string,
  filters: HybridSearchRequest,
  limit: number,
  scoreThreshold: number
): Promise<SemanticSearchHit[]> {
  try {
    // Generate query embedding
    const queryEmbedding = await embedText(query);

    // Build Qdrant filter
    const filter: Record<string, unknown> = {};

    if (filters.mimeType) {
      const types = Array.isArray(filters.mimeType) ? filters.mimeType : [filters.mimeType];
      filter.must = filter.must || [];
      (filter.must as Array<unknown>).push({
        key: 'mimeType',
        match: types.length === 1 ? { value: types[0] } : { any: types },
      });
    }


    if (filters.filePath) {
      filter.must = filter.must || [];
      (filter.must as Array<unknown>).push({
        key: 'filePath',
        match: { value: filters.filePath },
      });
    }

    const client = getQdrantClient();
    const searchResult = (await client.search({
      vector: queryEmbedding.vector,
      limit: limit * 2, // Fetch more for better merging
      scoreThreshold,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      withPayload: true,
    })) as { result: SemanticSearchHit[] };

    return searchResult.result || [];
  } catch (error) {
    log.warn({ err: error }, 'semantic search failed, continuing with keyword only');
    return [];
  }
}

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Merges ranked lists from multiple search systems
 * Formula: score = sum(weight / (k + rank))
 * where k is a constant (default 60) to prevent division by zero
 *
 * @param keywordResults - Results from Meilisearch
 * @param semanticResults - Results from Qdrant
 * @param keywordWeight - Weight for keyword results (0-1)
 * @param semanticWeight - Weight for semantic results (0-1)
 * @returns Merged and reranked results
 */
function reciprocalRankFusion(
  keywordResults: KeywordSearchResult[],
  semanticResults: SemanticSearchHit[],
  keywordWeight: number,
  semanticWeight: number
): HybridSearchResult[] {
  const k = 60; // RRF constant
  const scoreMap = new Map<string, HybridSearchResult>();

  // Process keyword results
  keywordResults.forEach((result, rank) => {
    const key = result.documentId;
    const rrfScore = keywordWeight / (k + rank + 1);

    scoreMap.set(key, {
      documentId: result.documentId,
      filePath: result.filePath,
      mimeType: result.mimeType,
      content: result.content,
      summary: result.summary,
      tags: result.tags,
      score: rrfScore,
      keywordScore: rrfScore,
      fromKeyword: true,
      fromSemantic: false,
      metadata: result.metadata,
    });
  });

  // Process semantic results
  semanticResults.forEach((result, rank) => {
    const key = result.id;
    const rrfScore = semanticWeight / (k + rank + 1);

    const existing = scoreMap.get(key);
    if (existing) {
      // Document appears in both results - combine scores
      existing.score += rrfScore;
      existing.semanticScore = rrfScore;
      existing.fromSemantic = true;
    } else {
      // New document from semantic search
      scoreMap.set(key, {
        documentId: result.id,
        filePath: result.payload.filePath,
        mimeType: (result.payload.mimeType as string | null) ?? null,
        content: result.payload.text,
        summary: null,
        tags: null,
        score: rrfScore,
        semanticScore: rrfScore,
        fromKeyword: false,
        fromSemantic: true,
        metadata: result.payload as Record<string, unknown>,
      });
    }
  });

  // Convert to array and sort by hybrid score (descending)
  const mergedResults = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);

  return mergedResults;
}
