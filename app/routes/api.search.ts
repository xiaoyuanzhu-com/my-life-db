import type { LoaderFunctionArgs } from "react-router";
import { getMeiliClient } from "~/.server/search/meili-client";
import { getQdrantClient } from "~/.server/search/qdrant-client";
import { embedText } from "~/.server/ai/embeddings";
import { getFileWithDigests } from "~/.server/db/files-with-digests";
import { getLogger } from "~/.server/log/logger";
import { readPrimaryText } from "~/.server/inbox/digest-artifacts";
import { TEXT_SOURCE_LABELS, type TextSourceType } from "~/.server/digest/text-source";
import type { FileWithDigests } from "~/types/file-card";

const log = getLogger({ module: "SearchAPI" });
const HIGHLIGHT_PRE_TAG = "<em>";
const HIGHLIGHT_POST_TAG = "</em>";

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** RLE mask format from SAM */
interface RleMask {
  size: [number, number]; // [height, width]
  counts: number[];
}

/** Matched object from image-objects digest for highlighting */
export interface MatchedObject {
  title: string;
  bbox: [number, number, number, number]; // normalized [0,1] coordinates [x1, y1, x2, y2]
  rle: RleMask | null;
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
  /** Matched object from image-objects for highlighting in image */
  matchedObject?: MatchedObject;
}

export interface SearchResponse {
  results: SearchResultItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  query: string;
  timing: { totalMs: number; searchMs: number; enrichMs: number };
  sources: ("keyword" | "semantic")[];
}

type SearchHit = {
  documentId: string;
  filePath: string;
  mimeType: string | null;
  content: string;
  summary: string | null;
  tags: string | null;
  _formatted?: { content?: string; summary?: string; tags?: string; filePath?: string };
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

    // Parse search types: "keyword", "semantic", or "keyword,semantic" (default)
    const typesParam = url.searchParams.get("types") || "keyword,semantic";
    const searchTypes = typesParam.split(",").map(t => t.trim().toLowerCase());
    const useKeyword = searchTypes.includes("keyword");
    const useSemantic = searchTypes.includes("semantic");

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

    if (!useKeyword && !useSemantic) {
      return Response.json(
        { error: 'Invalid types parameter. Use "keyword", "semantic", or "keyword,semantic"', code: "INVALID_TYPES" },
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

    const searchStart = Date.now();
    const highlightTerms = extractSearchTerms(query);
    let searchResult: {
      hits: SearchHit[];
      estimatedTotalHits: number;
      limit: number;
      offset: number;
      query: string;
    };
    const sources: ("keyword" | "semantic")[] = [];

    // Build Qdrant filter once if needed
    const buildQdrantFilter = () => {
      const qdrantFilter: Record<string, unknown> = {};
      if (typeFilter) {
        qdrantFilter.must = qdrantFilter.must || [];
        (qdrantFilter.must as unknown[]).push({ key: "mimeType", match: { value: typeFilter } });
      }
      if (pathFilter) {
        qdrantFilter.must = qdrantFilter.must || [];
        (qdrantFilter.must as unknown[]).push({ key: "filePath", match: { value: pathFilter } });
      }
      return Object.keys(qdrantFilter).length > 0 ? qdrantFilter : undefined;
    };

    // Semantic-only search
    if (useSemantic && !useKeyword) {
      try {
        const queryEmbedding = await embedText(query);
        const qdrantClient = await getQdrantClient();
        const qdrantFilter = buildQdrantFilter();

        const qdrantResult = (await qdrantClient.search({
          vector: queryEmbedding.vector,
          limit,
          scoreThreshold: 0.7,
          filter: qdrantFilter,
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

        sources.push("semantic");
        searchResult = {
          hits: Array.from(filePathMap.values()).slice(offset, offset + limit),
          estimatedTotalHits: filePathMap.size,
          limit,
          offset,
          query,
        };
      } catch (err) {
        log.error({ err }, "semantic search failed");
        throw err;
      }
    }
    // Keyword-only search
    else if (useKeyword && !useSemantic) {
      const client = await getMeiliClient();
      searchResult = await client.search<SearchHit>(query, {
        limit,
        offset,
        filter,
        attributesToHighlight: ["content", "summary", "tags", "filePath"],
        attributesToCrop: ["content"],
        cropLength: 200,
        matchingStrategy: "all",
      });
      sources.push("keyword");
    }
    // Both keyword and semantic (hybrid)
    else {
      try {
        const [meiliResult, qdrantHits] = await Promise.all([
          (async () => {
            const client = await getMeiliClient();
            return client.search<SearchHit>(query, {
              limit: limit * 2,
              offset: 0,
              filter,
              attributesToHighlight: ["content", "summary", "tags", "filePath"],
              attributesToCrop: ["content"],
              cropLength: 200,
              matchingStrategy: "all",
            });
          })(),
          (async () => {
            try {
              const queryEmbedding = await embedText(query);
              const qdrantClient = await getQdrantClient();
              const qdrantFilter = buildQdrantFilter();

              const qdrantResult = (await qdrantClient.search({
                vector: queryEmbedding.vector,
                limit: limit * 2,
                scoreThreshold: 0.7,
                filter: qdrantFilter,
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

        sources.push("keyword", "semantic");
        const mergedHits = Array.from(filePathMap.values());
        searchResult = {
          hits: mergedHits.slice(offset, offset + limit),
          estimatedTotalHits: mergedHits.length,
          limit,
          offset,
          query,
        };
      } catch {
        // Fallback to keyword-only if hybrid fails
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
        sources.push("keyword");
      }
    }

    const searchMs = Date.now() - searchStart;
    const enrichStart = Date.now();
    const results: SearchResultItem[] = [];

    // Number of lines displayed in text card preview (from text-card.tsx MAX_LINES)
    const PREVIEW_LINES = 20;

    for (const hit of searchResult.hits) {
      const fileWithDigests = getFileWithDigests(hit.filePath);
      if (!fileWithDigests) continue;

      const primaryText = await readPrimaryText(fileWithDigests.path);
      const fallbackPreview =
        hit.content.trim().length > 0 ? hit.content.trim().split("\n").slice(0, 60).join("\n") : undefined;
      const textPreview = primaryText ? primaryText.split("\n").slice(0, 60).join("\n") : fallbackPreview;
      const snippet = hit._formatted?.content || hit.content.slice(0, 200) + "...";

      // Check if term is visible in the displayed preview (first 20 lines)
      // If term is beyond preview, we still need to show match context
      const visiblePreview = primaryText ? primaryText.split("\n").slice(0, PREVIEW_LINES).join("\n") : null;
      const termVisibleInPreview = visiblePreview ? containsAnyTerm(visiblePreview, highlightTerms) : false;

      let matchContext: SearchResultItem["matchContext"] | undefined;
      if (hit._semantic) {
        matchContext = buildSemanticMatchContext({ semantic: hit._semantic, terms: highlightTerms });
      } else if (!termVisibleInPreview) {
        // Show context if term is not visible in the preview (either in digest or beyond preview line)
        matchContext = buildDigestMatchContext({ hit, file: fileWithDigests, terms: highlightTerms, primaryContainsTerm: termVisibleInPreview });
      }

      // For image files, check if we matched on image-objects and include the matched object for highlighting
      let matchedObject: MatchedObject | undefined;
      if (fileWithDigests.mimeType?.startsWith('image/')) {
        matchedObject = findMatchingObject(fileWithDigests, highlightTerms);
      }

      results.push({ ...fileWithDigests, textPreview, score: 1.0, snippet, highlights: hit._formatted, matchContext, matchedObject });
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
      sources,
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

/** DetectedObject structure from image-objects digest */
interface DetectedObject {
  title: string;
  category?: string;
  description?: string;
  bbox: [number, number, number, number];
  rle: RleMask | null;
}

/**
 * Find the first object in image-objects digest that matches any search term
 * Returns the object with its bbox and rle for highlighting
 */
function findMatchingObject(file: FileWithDigests, terms: string[]): MatchedObject | undefined {
  // Find the image-objects digest
  const objectsDigest = file.digests.find(d => d.type === 'image-objects' && d.content);
  if (!objectsDigest?.content) return undefined;

  try {
    const data = JSON.parse(objectsDigest.content);
    const objects: DetectedObject[] = data.objects || [];

    // Find the first object that matches any search term
    for (const obj of objects) {
      const searchableText = [obj.title, obj.description].filter(Boolean).join(' ').toLowerCase();
      const matchesTerm = terms.some(term => searchableText.includes(term.toLowerCase()));
      if (matchesTerm) {
        return {
          title: obj.title,
          bbox: obj.bbox,
          rle: obj.rle,
        };
      }
    }
  } catch (e) {
    log.warn({ err: e, filePath: file.path }, 'failed to parse image-objects digest for matching');
  }

  return undefined;
}

function hasHighlight(value?: string | null): value is string {
  return Boolean(value && value.includes(HIGHLIGHT_PRE_TAG));
}

const DIGEST_FIELD_CONFIG: Array<{
  field: "filePath" | "summary" | "tags" | "content";
  digesterTypes: string[];
  label: string;
  requirePrimaryMiss?: boolean;
}> = [
  // File path is checked first - always show context since path isn't displayed on card
  { field: "filePath", digesterTypes: [], label: "File path" },
  { field: "summary", digesterTypes: ["url-crawl-summary"], label: "Summary" },
  { field: "tags", digesterTypes: ["tags"], label: "Tags" },
  {
    field: "content",
    // All digest types that can provide content (in priority order from ingest-to-meilisearch.ts)
    digesterTypes: ["url-crawl-content", "doc-to-markdown", "image-ocr", "image-captioning", "image-objects", "speech-recognition"],
    label: "File Content", // Fallback when no digest found (raw text file)
    requirePrimaryMiss: true,
  },
];

/**
 * Additional digest labels not covered by TEXT_SOURCE_LABELS
 * (summary, tags, and other non-content digests)
 */
const ADDITIONAL_DIGEST_LABELS: Record<string, string> = {
  "url-crawl-summary": "Summary",
  "tags": "Tags",
};

function getDigestLabel(type: string, fallback: string): string {
  // Check TEXT_SOURCE_LABELS first (content sources)
  if (type in TEXT_SOURCE_LABELS) {
    return TEXT_SOURCE_LABELS[type as TextSourceType];
  }
  // Check additional digest labels (summary, tags)
  if (type in ADDITIONAL_DIGEST_LABELS) {
    return ADDITIONAL_DIGEST_LABELS[type];
  }
  return fallback;
}

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
  // Use same labels as keyword search for consistency
  const sourceLabel = getDigestLabel(sourceType, sourceType === "content" ? "File content" : sourceType);
  return { source: "semantic", snippet, terms, score, sourceType: sourceLabel };
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

    const snippet = extractSnippetFromFormatted(formattedValue);
    if (!snippet?.trim()) continue;

    // For content field with multiple potential sources, find which digest actually contains the matched text
    let matchedDigest = file.digests.find((d) => config.digesterTypes.includes(d.type));

    if (config.field === "content" && config.digesterTypes.length > 1) {
      // Check each potential digest to find which one actually contains the search terms
      for (const digesterType of config.digesterTypes) {
        const digest = file.digests.find((d) => d.type === digesterType && d.content);
        if (digest?.content) {
          // For image-objects, parse and check objects array
          if (digesterType === "image-objects") {
            try {
              const data = JSON.parse(digest.content);
              const objects = data.objects || [];
              const objectsText = objects.map((obj: { title?: string; description?: string }) =>
                [obj.title, obj.description].filter(Boolean).join(' ')
              ).join(' ').toLowerCase();
              if (terms.some(term => objectsText.includes(term.toLowerCase()))) {
                matchedDigest = digest;
                break;
              }
            } catch {
              // Skip if can't parse
            }
          } else {
            // For other digests, check content directly
            const contentLower = digest.content.toLowerCase();
            if (terms.some(term => contentLower.includes(term.toLowerCase()))) {
              matchedDigest = digest;
              break;
            }
          }
        }
      }
    }

    return {
      source: "digest",
      snippet,
      terms,
      digest: matchedDigest
        ? { type: matchedDigest.type, label: getDigestLabel(matchedDigest.type, config.label) }
        : { type: config.field, label: config.label },
    };
  }
  return undefined;
}

function containsAnyTerm(text: string, terms: string[]): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}
