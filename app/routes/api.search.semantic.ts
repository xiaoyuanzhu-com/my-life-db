import type { ActionFunctionArgs } from "react-router";
import { getQdrantClient } from "~/lib/search/qdrant-client";
import { embedText } from "~/lib/ai/embeddings";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "SemanticSearchAPI" });

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
    const scoreThreshold = body.scoreThreshold ?? 0.7;

    const filter: Record<string, unknown> = {};
    if (body.contentType) {
      const types = Array.isArray(body.contentType) ? body.contentType : [body.contentType];
      filter.must = filter.must || [];
      (filter.must as unknown[]).push({ key: "contentType", match: types.length === 1 ? { value: types[0] } : { any: types } });
    }
    if (body.sourceType) {
      const types = Array.isArray(body.sourceType) ? body.sourceType : [body.sourceType];
      filter.must = filter.must || [];
      (filter.must as unknown[]).push({ key: "sourceType", match: types.length === 1 ? { value: types[0] } : { any: types } });
    }
    if (body.filePath) {
      filter.must = filter.must || [];
      (filter.must as unknown[]).push({ key: "filePath", match: { value: body.filePath } });
    }

    log.info({ query }, "generating query embedding");
    const queryEmbedding = await embedText(query);

    const client = await getQdrantClient();
    const searchResult = (await client.search({
      vector: queryEmbedding.vector,
      limit,
      scoreThreshold,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      withPayload: true,
    })) as { result: unknown[] };

    const results = searchResult.result || [];

    log.info(
      { query, limit, scoreThreshold, filter: Object.keys(filter).length > 0 ? filter : undefined, hits: results.length },
      "semantic search completed"
    );

    return Response.json({ results, query, limit, scoreThreshold });
  } catch (error) {
    log.error({ err: error }, "semantic search failed");
    const errorMessage = error instanceof Error ? error.message : "unknown error";

    if (errorMessage.includes("QDRANT_URL is not configured")) {
      return Response.json({ error: "Qdrant is not configured" }, { status: 503 });
    }
    if (errorMessage.includes("collection") && errorMessage.includes("not found")) {
      return Response.json({ error: "Vector collection not found" }, { status: 503 });
    }
    return Response.json({ error: "Internal server error", details: errorMessage }, { status: 500 });
  }
}
