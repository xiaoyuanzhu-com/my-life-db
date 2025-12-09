import type { ActionFunctionArgs } from "react-router";
import { getMeiliClient } from "~/lib/search/meili-client";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "KeywordSearchAPI" });

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
    const offset = body.offset ?? 0;

    const filters: string[] = [];
    if (body.mimeType) {
      const types = Array.isArray(body.mimeType) ? body.mimeType : [body.mimeType];
      if (types.length === 1) {
        filters.push(`mimeType = "${escapeFilterValue(types[0])}"`);
      } else if (types.length > 1) {
        filters.push(`mimeType IN [${types.map((t: string) => `"${escapeFilterValue(t)}"`).join(", ")}]`);
      }
    }
    if (body.filePath) {
      filters.push(`filePath = "${escapeFilterValue(body.filePath)}"`);
    }

    const filter = filters.length > 0 ? filters.join(" AND ") : undefined;
    const client = await getMeiliClient();

    const searchResult = await client.search(query, {
      limit,
      offset,
      filter,
      attributesToHighlight: ["content", "summary", "tags"],
      attributesToCrop: ["content"],
      cropLength: 300,
    });

    log.info(
      { query, limit, offset, filter, hits: searchResult.hits.length, total: searchResult.estimatedTotalHits },
      "keyword search completed"
    );

    return Response.json({
      results: searchResult.hits,
      query: searchResult.query,
      total: searchResult.estimatedTotalHits,
      limit: searchResult.limit,
      offset: searchResult.offset,
      processingTimeMs: searchResult.processingTimeMs,
    });
  } catch (error) {
    log.error({ err: error }, "keyword search failed");
    const errorMessage = error instanceof Error ? error.message : "unknown error";

    if (errorMessage.includes("MEILI_HOST is not configured")) {
      return Response.json({ error: "Meilisearch is not configured" }, { status: 503 });
    }
    if (errorMessage.includes("404")) {
      return Response.json({ error: "Search index not found" }, { status: 503 });
    }
    return Response.json({ error: "Internal server error", details: errorMessage }, { status: 500 });
  }
}
