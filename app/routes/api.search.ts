import type { LoaderFunctionArgs } from "react-router";
import { getMeiliClient } from "~/lib/search/meili-client";
import { getQdrantClient } from "~/lib/search/qdrant-client";
import { embedText } from "~/lib/ai/embeddings";
import { getFileWithDigests } from "~/lib/db/files-with-digests";
import { getLogger } from "~/lib/log/logger";
import { readPrimaryText } from "~/lib/inbox/digest-artifacts";
import type { FileWithDigests } from "~/types/file-card";

const log = getLogger({ module: "SearchAPI" });
const HIGHLIGHT_PRE_TAG = "<em>";
const HIGHLIGHT_POST_TAG = "</em>";

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface SearchResultItem extends FileWithDigests {
  score: number;
  snippet: string;
  highlights?: { content?: string; summary?: string; tags?: string };
  matchContext?: {
    source: "digest" | "semantic";
    snippet: string;
    terms: string[];
    score?: number;
    sourceType?: string;
    digest?: { type: string; label: string };
  };
}

export interface SearchResponse {
  results: SearchResultItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  query: string;
  timing: { totalMs: number; searchMs: number; enrichMs: number };
}

type SearchHit = {
  documentId: string;
  filePath: string;
  mimeType: string | null;
  content: string;
  summary: string | null;
  tags: string | null;
  _formatted?: { content?: string; summary?: string; tags?: string };
  _semantic?: { score: number; chunkText: string; sourceType: string };
};

export async function loader({ request }: LoaderFunctionArgs) {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);
    const typeFilter = url.searchParams.get("type") || undefined;
    const pathFilter = url.searchParams.get("path") || undefined;

    if (!query) {
      return Response.json(
        { error: 'Query parameter "q" is required', code: "QUERY_REQUIRED" },
        { status: 400 }
      );
    }

    if (query.length < 2) {
      return Response.json(
        { error: "Query must be at least 2 characters", code: "QUERY_TOO_SHORT" },
        { status: 400 }
      );
    }

    const filters: string[] = [];
    if (typeFilter) {
      filters.push(`mimeType STARTS WITH "${escapeFilterValue(typeFilter)}"`);
    }
    if (pathFilter) {
      filters.push(`filePath STARTS WITH "${escapeFilterValue(pathFilter)}"`);
    }
    const filter = filters.length > 0 ? filters.join(" AND ") : undefined;

    const queryWords = query.split(/\s+/).filter((word) => word.length > 0);
    const wordCount = queryWords.length;
    const useSemanticOnly = wordCount > 10;

    const searchStart = Date.now();
    const highlightTerms = extractSearchTerms(query);
    let searchResult: {
      hits: SearchHit[];
      estimatedTotalHits: number;
      limit: number;
      offset: number;
      query: string;
    };

    if (useSemanticOnly) {
      try {
        const queryEmbedding = await embedText(query);
        const qdrantClient = await getQdrantClient();
        const qdrantFilter: Record<string, unknown> = {};
        if (typeFilter) {
          qdrantFilter.must = qdrantFilter.must || [];
          (qdrantFilter.must as unknown[]).push({ key: "mimeType", match: { value: typeFilter } });
        }
        if (pathFilter) {
          qdrantFilter.must = qdrantFilter.must || [];
          (qdrantFilter.must as unknown[]).push({ key: "filePath", match: { value: pathFilter } });
        }

        const qdrantResult = (await qdrantClient.search({
          vector: queryEmbedding.vector,
          limit,
          scoreThreshold: 0.7,
          filter: Object.keys(qdrantFilter).length > 0 ? qdrantFilter : undefined,
          withPayload: true,
        })) as {
          result: { id: string; score: number; payload: { filePath: string; text: string; sourceType?: string } }[];
        };

        const filePathMap = new Map<string, SearchHit>();
        for (const hit of qdrantResult.result || []) {
          const filePath = hit.payload.filePath;
          if (!filePathMap.has(filePath)) {
            filePathMap.set(filePath, {
              documentId: hit.id,
              filePath,
              mimeType: null,
              content: hit.payload.text,
              summary: null,
              tags: null,
              _semantic: { score: hit.score, chunkText: hit.payload.text, sourceType: hit.payload.sourceType || "content" },
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
      } catch {
        const client = await getMeiliClient();
        searchResult = await client.search<SearchHit>(query, {
          limit,
          offset,
          filter,
          attributesToHighlight: ["content", "summary", "tags"],
          attributesToCrop: ["content"],
          cropLength: 200,
          matchingStrategy: "all",
        });
      }
    } else {
      try {
        const [meiliResult, qdrantHits] = await Promise.all([
          (async () => {
            const client = await getMeiliClient();
            return client.search<SearchHit>(query, {
              limit: limit * 2,
              offset: 0,
              filter,
              attributesToHighlight: ["content", "summary", "tags"],
              attributesToCrop: ["content"],
              cropLength: 200,
              matchingStrategy: "all",
            });
          })(),
          (async () => {
            try {
              const queryEmbedding = await embedText(query);
              const qdrantClient = await getQdrantClient();
              const qdrantFilter: Record<string, unknown> = {};
              if (typeFilter) {
                qdrantFilter.must = qdrantFilter.must || [];
                (qdrantFilter.must as unknown[]).push({ key: "mimeType", match: { value: typeFilter } });
              }
              if (pathFilter) {
                qdrantFilter.must = qdrantFilter.must || [];
                (qdrantFilter.must as unknown[]).push({ key: "filePath", match: { value: pathFilter } });
              }

              const qdrantResult = (await qdrantClient.search({
                vector: queryEmbedding.vector,
                limit: limit * 2,
                scoreThreshold: 0.7,
                filter: Object.keys(qdrantFilter).length > 0 ? qdrantFilter : undefined,
                withPayload: true,
              })) as {
                result: { id: string; score: number; payload: { filePath: string; text: string; sourceType?: string } }[];
              };

              return qdrantResult.result || [];
            } catch {
              return [];
            }
          })(),
        ]);

        const filePathMap = new Map<string, SearchHit>();
        for (const hit of meiliResult.hits) {
          filePathMap.set(hit.filePath, hit);
        }
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
              _semantic: { score: hit.score, chunkText: hit.payload.text, sourceType: hit.payload.sourceType || "content" },
            });
          }
        }

        const mergedHits = Array.from(filePathMap.values());
        searchResult = {
          hits: mergedHits.slice(offset, offset + limit),
          estimatedTotalHits: mergedHits.length,
          limit,
          offset,
          query,
        };
      } catch {
        const client = await getMeiliClient();
        searchResult = await client.search<SearchHit>(query, {
          limit,
          offset,
          filter,
          attributesToHighlight: ["content", "summary", "tags"],
          attributesToCrop: ["content"],
          cropLength: 200,
          matchingStrategy: "all",
        });
      }
    }

    const searchMs = Date.now() - searchStart;
    const enrichStart = Date.now();
    const results: SearchResultItem[] = [];

    for (const hit of searchResult.hits) {
      const fileWithDigests = getFileWithDigests(hit.filePath);
      if (!fileWithDigests) continue;

      const primaryText = await readPrimaryText(fileWithDigests.path);
      const fallbackPreview =
        hit.content.trim().length > 0 ? hit.content.trim().split("\n").slice(0, 60).join("\n") : undefined;
      const textPreview = primaryText ? primaryText.split("\n").slice(0, 60).join("\n") : fallbackPreview;
      const snippet = hit._formatted?.content || hit.content.slice(0, 200) + "...";
      const primaryContainsTerm = primaryText ? containsAnyTerm(primaryText, highlightTerms) : false;

      let matchContext: SearchResultItem["matchContext"] | undefined;
      if (hit._semantic) {
        matchContext = buildSemanticMatchContext({ semantic: hit._semantic, terms: highlightTerms });
      } else if (!primaryContainsTerm) {
        matchContext = buildDigestMatchContext({ hit, file: fileWithDigests, terms: highlightTerms, primaryContainsTerm });
      }

      results.push({ ...fileWithDigests, textPreview, score: 1.0, snippet, highlights: hit._formatted, matchContext });
    }

    const enrichMs = Date.now() - enrichStart;
    const totalMs = Date.now() - startTime;

    return Response.json({
      results,
      pagination: {
        total: searchResult.estimatedTotalHits,
        limit: searchResult.limit,
        offset: searchResult.offset,
        hasMore: searchResult.offset + searchResult.hits.length < searchResult.estimatedTotalHits,
      },
      query: searchResult.query,
      timing: { totalMs, searchMs, enrichMs },
    });
  } catch (error) {
    log.error({ err: error }, "search failed");
    const errorMessage = error instanceof Error ? error.message : "unknown error";

    if (errorMessage.includes("MEILI_HOST is not configured")) {
      return Response.json({ error: "Search is not configured", code: "SEARCH_NOT_CONFIGURED" }, { status: 503 });
    }
    if (errorMessage.includes("404") || errorMessage.includes("index_not_found")) {
      return Response.json({ error: "Search index not found", code: "INDEX_NOT_FOUND" }, { status: 503 });
    }
    return Response.json({ error: "Internal server error", details: errorMessage }, { status: 500 });
  }
}

function extractSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/\s+/)
        .map((term) => term.replace(/^['"]+|['"]+$/g, "").trim())
        .filter((term) => term.length > 0)
    )
  );
}

function hasHighlight(value?: string | null): value is string {
  return Boolean(value && value.includes(HIGHLIGHT_PRE_TAG));
}

const DIGEST_FIELD_CONFIG = [
  { field: "summary" as const, digesterTypes: ["summary", "url-crawl-summary", "summarize"], label: "Summary digest" },
  { field: "tags" as const, digesterTypes: ["tags"], label: "Tags digest" },
  {
    field: "content" as const,
    digesterTypes: ["url-crawl-content", "content-md", "url-content-md"],
    label: "Crawled digest",
    requirePrimaryMiss: true,
  },
];

function buildSemanticMatchContext({
  semantic,
  terms,
}: {
  semantic: { score: number; chunkText: string; sourceType: string };
  terms: string[];
}): SearchResultItem["matchContext"] {
  const { score, chunkText, sourceType } = semantic;
  const maxLength = 300;
  const snippet = chunkText.length > maxLength ? chunkText.slice(0, maxLength).trim() + "..." : chunkText;
  const sourceLabels: Record<string, string> = { content: "File content", summary: "Summary", tags: "Tags" };
  return { source: "semantic", snippet, terms, score, sourceType: sourceLabels[sourceType] || sourceType };
}

function extractSnippetFromFormatted(formattedText: string, maxLength = 200): string {
  const highlightStart = formattedText.indexOf(HIGHLIGHT_PRE_TAG);
  if (highlightStart === -1) return formattedText.slice(0, maxLength);

  const contextRadius = 80;
  const start = Math.max(0, highlightStart - contextRadius);
  const end = Math.min(formattedText.length, highlightStart + contextRadius + 100);

  let snippet = formattedText.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < formattedText.length) snippet = snippet + "...";

  if (snippet.length > maxLength) {
    const firstHighlight = snippet.indexOf(HIGHLIGHT_PRE_TAG);
    const highlightEnd = snippet.indexOf(HIGHLIGHT_POST_TAG, firstHighlight);
    if (firstHighlight !== -1 && highlightEnd !== -1) {
      const minLength = highlightEnd + HIGHLIGHT_POST_TAG.length + 20;
      snippet = snippet.slice(0, Math.max(maxLength, minLength)) + "...";
    } else {
      snippet = snippet.slice(0, maxLength) + "...";
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
}): SearchResultItem["matchContext"] | undefined {
  if (terms.length === 0) return undefined;

  for (const config of DIGEST_FIELD_CONFIG) {
    const formattedValue = hit._formatted?.[config.field];
    if (!hasHighlight(formattedValue)) continue;
    if (config.requirePrimaryMiss && primaryContainsTerm) continue;

    const digest = file.digests.find((d) => config.digesterTypes.includes(d.type));
    const snippet = extractSnippetFromFormatted(formattedValue);
    if (!snippet?.trim()) continue;

    return {
      source: "digest",
      snippet,
      terms,
      digest: digest
        ? { type: digest.type, label: getDigestLabel(digest.type, config.label) }
        : { type: config.field, label: config.label },
    };
  }
  return undefined;
}

function getDigestLabel(type: string, fallback: string): string {
  if (["summary", "url-crawl-summary", "summarize"].includes(type)) return "Summary digest";
  if (type === "tags") return "Tags digest";
  if (["url-crawl-content", "content-md", "url-content-md"].includes(type)) return "Crawled digest";
  return fallback;
}

function containsAnyTerm(text: string, terms: string[]): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}
