/**
 * MeiliDocument - Meilisearch documents table models
 *
 * The meili_documents table stores full-text documents for Meilisearch indexing.
 * 1:1 file-to-document mapping (one document per file).
 * Documents are rebuildable from filesystem + digests.
 */

/**
 * Meilisearch sync status
 */
export type MeiliStatus = 'pending' | 'indexing' | 'indexed' | 'deleting' | 'deleted' | 'error';

/**
 * MeiliDocument record row (snake_case - matches SQLite schema exactly)
 */
export interface MeiliDocumentRow {
  /** UUID (unique identifier for Meilisearch) */
  document_id: string;

  /** File path (e.g., 'inbox/article.md') */
  file_path: string;

  /** Main file content */
  content: string;

  /** AI-generated summary (from digest) */
  summary: string | null;

  /** Comma-separated tags (from digest) */
  tags: string | null;

  /** SHA256 for change detection */
  content_hash: string;

  /** Word count for stats */
  word_count: number;

  /** MIME type from filesystem */
  mime_type: string | null;

  /** Additional context (JSON string) */
  metadata_json: string | null;

  /** Sync status */
  meili_status: MeiliStatus;

  /** Meilisearch task ID */
  meili_task_id: string | null;

  /** Epoch ms timestamp when indexed */
  meili_indexed_at: number | null;

  /** Error message if failed */
  meili_error: string | null;

  /** Epoch ms timestamp when document was created */
  created_at: number;

  /** Epoch ms timestamp when document was last updated */
  updated_at: number;
}

/**
 * MeiliDocument record (camelCase - for TypeScript usage)
 */
export interface MeiliDocument {
  /** UUID (unique identifier for Meilisearch) */
  documentId: string;

  /** File path (e.g., 'inbox/article.md') */
  filePath: string;

  /** Main file content */
  content: string;

  /** AI-generated summary (from digest) */
  summary: string | null;

  /** Comma-separated tags (from digest) */
  tags: string | null;

  /** SHA256 for change detection */
  contentHash: string;

  /** Word count for stats */
  wordCount: number;

  /** MIME type from filesystem */
  mimeType: string | null;

  /** Additional context (JSON string) */
  metadataJson: string | null;

  /** Sync status */
  meiliStatus: MeiliStatus;

  /** Meilisearch task ID */
  meiliTaskId: string | null;

  /** Epoch ms timestamp when indexed */
  meiliIndexedAt: number | null;

  /** Error message if failed */
  meiliError: string | null;

  /** Epoch ms timestamp when document was created */
  createdAt: number;

  /** Epoch ms timestamp when document was last updated */
  updatedAt: number;
}

/**
 * Conversion helper: MeiliDocumentRow → MeiliDocument
 */
export function rowToMeiliDocument(row: MeiliDocumentRow): MeiliDocument {
  return {
    documentId: row.document_id,
    filePath: row.file_path,
    content: row.content,
    summary: row.summary,
    tags: row.tags,
    contentHash: row.content_hash,
    wordCount: row.word_count,
    mimeType: row.mime_type,
    metadataJson: row.metadata_json,
    meiliStatus: row.meili_status,
    meiliTaskId: row.meili_task_id,
    meiliIndexedAt: row.meili_indexed_at,
    meiliError: row.meili_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
