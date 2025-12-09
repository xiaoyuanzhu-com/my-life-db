import type { ActionFunctionArgs } from "react-router";
import { getMeiliClient } from "~/lib/search/meili-client";
import { getQdrantClient } from "~/lib/search/qdrant-client";
import { embedText } from "~/lib/ai/embeddings";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "HybridSearchAPI" });

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();

    if (!body.query || typeof body.query !== "string") {
      return Response.json({ error: "query is required and must be a string" }, { status: 400 });
    }

    const query = body.query.trim();
    if (query.length === 0) {
      return Response.json({ error: "query cannot be empty" }, { status: 400 });
    }

    const limit = Math.min(body.limit ?? 20, 100);
    const keywordWeight = body.keywordWeight ?? 0.5;
    const semanticWeight = body.semanticWeight ?? 0.5;
    const scoreThreshold = body.scoreThreshold ?? 0.7;

    const [keywordResults, semanticResults] = await Promise.all([
      fetchKeywordResults(query, body, limit),
      fetchSemanticResults(query, body, limit, scoreThreshold),
    ]);

    const mergedResults = reciprocalRankFusion(keywordResults, semanticResults, keywordWeight, semanticWeight);
    const finalResults = mergedResults.slice(0, limit);

    return Response.json({
      results: finalResults,
      query,
      limit,
      keywordCount: keywordResults.length,
      semanticCount: semanticResults.length,
      hybridCount: finalResults.length,
    });
  } catch (error) {
    log.error({ err: error }, "hybrid search failed");
    const errorMessage = error instanceof Error ? error.message : "unknown error";
    return Response.json({ error: "Internal server error", details: errorMessage }, { status: 500 });
  }
}

async function fetchKeywordResults(query: string, filters: Record<string, unknown>, limit: number) {
  try {
    const client = await getMeiliClient();
    const filterParts: string[] = [];

    if (filters.mimeType) {
      const types = Array.isArray(filters.mimeType) ? filters.mimeType : [filters.mimeType];
      if (types.length === 1) {
        filterParts.push(`mimeType = "${escapeFilterValue(types[0])}"`);
      } else if (types.length > 1) {
        filterParts.push(`mimeType IN [${types.map((t: string) => `"${escapeFilterValue(t)}"`).join(", ")}]`);
      }
    }
    if (filters.filePath) {
      filterParts.push(`filePath = "${escapeFilterValue(filters.filePath as string)}"`);
    }

    const filter = filterParts.length > 0 ? filterParts.join(" AND ") : undefined;
    const searchResult = await client.search(query, { limit: limit * 2, offset: 0, filter });
    return searchResult.hits as { documentId: string; filePath: string; mimeType: string | null; content: string; summary: string | null; tags: string | null; metadata?: Record<string, unknown> }[];
  } catch {
    return [];
  }
}

async function fetchSemanticResults(query: string, filters: Record<string, unknown>, limit: number, scoreThreshold: number) {
  try {
    const queryEmbedding = await embedText(query);
    const filter: Record<string, unknown> = {};

    if (filters.mimeType) {
      const types = Array.isArray(filters.mimeType) ? filters.mimeType : [filters.mimeType];
      filter.must = filter.must || [];
      (filter.must as unknown[]).push({ key: "mimeType", match: types.length === 1 ? { value: types[0] } : { any: types } });
    }
    if (filters.filePath) {
      filter.must = filter.must || [];
      (filter.must as unknown[]).push({ key: "filePath", match: { value: filters.filePath } });
    }

    const client = await getQdrantClient();
    const searchResult = (await client.search({
      vector: queryEmbedding.vector,
      limit: limit * 2,
      scoreThreshold,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      withPayload: true,
    })) as { result: { id: string; score: number; payload: { filePath: string; text: string; mimeType?: string | null } }[] };

    return searchResult.result || [];
  } catch {
    return [];
  }
}

function reciprocalRankFusion(
  keywordResults: { documentId: string; filePath: string; mimeType: string | null; content: string; summary: string | null; tags: string | null; metadata?: Record<string, unknown> }[],
  semanticResults: { id: string; score: number; payload: { filePath: string; text: string; mimeType?: string | null } }[],
  keywordWeight: number,
  semanticWeight: number
) {
  const k = 60;
  const scoreMap = new Map<string, Record<string, unknown>>();

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

  semanticResults.forEach((result, rank) => {
    const key = result.id;
    const rrfScore = semanticWeight / (k + rank + 1);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score = (existing.score as number) + rrfScore;
      existing.semanticScore = rrfScore;
      existing.fromSemantic = true;
    } else {
      scoreMap.set(key, {
        documentId: result.id,
        filePath: result.payload.filePath,
        mimeType: result.payload.mimeType ?? null,
        content: result.payload.text,
        summary: null,
        tags: null,
        score: rrfScore,
        semanticScore: rrfScore,
        fromKeyword: false,
        fromSemantic: true,
        metadata: result.payload,
      });
    }
  });

  return Array.from(scoreMap.values()).sort((a, b) => (b.score as number) - (a.score as number));
}
