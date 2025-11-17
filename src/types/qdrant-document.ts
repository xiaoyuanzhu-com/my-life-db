/**
 * QdrantDocument - Qdrant documents table models
 *
 * The qdrant_documents table stores chunked documents for Qdrant vector search.
 * Each file is split into chunks (800-1000 tokens) with overlap for context preservation.
 * Documents are rebuildable from filesystem + digests.
 */

/**
 * Embedding sync status
 */
export type EmbeddingStatus = 'pending' | 'indexing' | 'indexed' | 'deleting' | 'deleted' | 'error';

/**
 * Source type for chunks
 */
export type SourceType = 'content' | 'summary' | 'tags';

/**
 * QdrantDocument record row (snake_case - matches SQLite schema exactly)
 */
export interface QdrantDocumentRow {
  /** Document ID (e.g., 'inbox/article.md:content:0') */
  document_id: string;

  /** File path (e.g., 'inbox/article.md') */
  file_path: string;

  /** Source type: 'content' | 'summary' | 'tags' */
  source_type: SourceType;

  /** 0-based chunk index */
  chunk_index: number;

  /** Total chunks for this file+source */
  chunk_count: number;

  /** 800-1000 tokens of text */
  chunk_text: string;

  /** Character position start in original */
  span_start: number;

  /** Character position end in original */
  span_end: number;

  /** Number of overlapping tokens from previous chunk */
  overlap_tokens: number;

  /** Word count for stats */
  word_count: number;

  /** Token count for stats */
  token_count: number;

  /** SHA256 for change detection */
  content_hash: string;

  /** Additional context (JSON string) */
  metadata_json: string | null;

  /** Sync status */
  embedding_status: EmbeddingStatus;

  /** Embedding model version */
  embedding_version: number;

  /** UUID in Qdrant collection */
  qdrant_point_id: string | null;

  /** ISO timestamp when indexed */
  qdrant_indexed_at: string | null;

  /** Error message if failed */
  qdrant_error: string | null;

  /** ISO timestamp when document was created */
  created_at: string;

  /** ISO timestamp when document was last updated */
  updated_at: string;
}

/**
 * QdrantDocument record (camelCase - for TypeScript usage)
 */
export interface QdrantDocument {
  /** Document ID (e.g., 'inbox/article.md:content:0') */
  documentId: string;

  /** File path (e.g., 'inbox/article.md') */
  filePath: string;

  /** Source type: 'content' | 'summary' | 'tags' */
  sourceType: SourceType;

  /** 0-based chunk index */
  chunkIndex: number;

  /** Total chunks for this file+source */
  chunkCount: number;

  /** 800-1000 tokens of text */
  chunkText: string;

  /** Character position start in original */
  spanStart: number;

  /** Character position end in original */
  spanEnd: number;

  /** Number of overlapping tokens from previous chunk */
  overlapTokens: number;

  /** Word count for stats */
  wordCount: number;

  /** Token count for stats */
  tokenCount: number;

  /** SHA256 for change detection */
  contentHash: string;

  /** Additional context (JSON string) */
  metadataJson: string | null;

  /** Sync status */
  embeddingStatus: EmbeddingStatus;

  /** Embedding model version */
  embeddingVersion: number;

  /** UUID in Qdrant collection */
  qdrantPointId: string | null;

  /** ISO timestamp when indexed */
  qdrantIndexedAt: string | null;

  /** Error message if failed */
  qdrantError: string | null;

  /** ISO timestamp when document was created */
  createdAt: string;

  /** ISO timestamp when document was last updated */
  updatedAt: string;
}

/**
 * Conversion helper: QdrantDocumentRow → QdrantDocument
 */
export function rowToQdrantDocument(row: QdrantDocumentRow): QdrantDocument {
  return {
    documentId: row.document_id,
    filePath: row.file_path,
    sourceType: row.source_type,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    chunkText: row.chunk_text,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    overlapTokens: row.overlap_tokens,
    wordCount: row.word_count,
    tokenCount: row.token_count,
    contentHash: row.content_hash,
    metadataJson: row.metadata_json,
    embeddingStatus: row.embedding_status,
    embeddingVersion: row.embedding_version,
    qdrantPointId: row.qdrant_point_id,
    qdrantIndexedAt: row.qdrant_indexed_at,
    qdrantError: row.qdrant_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
