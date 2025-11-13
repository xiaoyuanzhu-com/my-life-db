import 'server-only';

/**
 * Content type of the source material
 * Matches inbox/library types for consistency
 */
export type ContentType = 'text' | 'url' | 'image' | 'audio' | 'video' | 'pdf' | 'mixed';

/**
 * Variant represents different processing outputs from the same source
 * - content: Main extracted/transcribed content (markdown for URLs, transcript for audio, caption for images)
 * - summary: AI-generated summary
 * - raw: Original unprocessed content
 */
export type SearchVariant = 'content' | 'summary' | 'raw';

export type SearchDocumentSyncStatus =
  | 'pending'
  | 'indexing'
  | 'indexed'
  | 'deleting'
  | 'deleted'
  | 'error';

export interface SearchDocumentMetadata {
  // Common fields for all content types
  title?: string | null;
  description?: string | null;
  author?: string | null;
  tags?: string[];
  capturedAt?: string | null;

  // URL-specific
  url?: string | null;
  hostname?: string | null;
  path?: string | null;

  // File-specific
  digestPath?: string | null;
  screenshotPath?: string | null;
  filePath?: string | null;
  mimeType?: string | null;

  // Audio/Video-specific
  durationSeconds?: number | null;
  transcriptionModel?: string | null;

  // Image-specific
  captionModel?: string | null;
  width?: number | null;
  height?: number | null;

  // Extensible for future fields
  [key: string]: unknown;
}

export interface ChunkDescriptor {
  chunkIndex: number;
  chunkCount: number;
  text: string;
  spanStart: number;
  spanEnd: number;
  overlapTokens: number;
  wordCount: number;
  tokenCount: number;
}

export interface SearchDocumentRecord {
  documentId: string;
  entryId: string;
  libraryId: string | null;

  // Content type and processing variant
  contentType: ContentType;
  variant: SearchVariant;

  // Source information
  sourceUrl: string | null;
  sourcePath: string;

  // Chunking information
  chunkIndex: number;
  chunkCount: number;
  spanStart: number;
  spanEnd: number;
  overlapTokens: number;
  wordCount: number;
  tokenCount: number;
  contentHash: string;
  chunkText: string;

  // Metadata (type-specific fields)
  metadata: SearchDocumentMetadata;

  // Sync status for Meilisearch
  meiliStatus: SearchDocumentSyncStatus;
  meiliTaskId: string | null;
  lastIndexedAt: string | null;
  lastDeindexedAt: string | null;

  // Sync status for vector embeddings
  embeddingStatus: SearchDocumentSyncStatus;
  embeddingVersion: number;
  lastEmbeddedAt: string | null;

  // Error tracking
  lastError: string | null;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export interface SearchDocumentInsert {
  documentId: string;
  entryId: string;
  libraryId: string | null;
  contentType: ContentType;
  sourceUrl: string | null;
  sourcePath: string;
  variant: SearchVariant;
  chunkIndex: number;
  chunkCount: number;
  spanStart: number;
  spanEnd: number;
  overlapTokens: number;
  wordCount: number;
  tokenCount: number;
  contentHash: string;
  chunkText: string;
  metadata: SearchDocumentMetadata;
}

/**
 * Unified document payload for Meilisearch
 * 1:1 file-to-document mapping with embedded digests
 */
export interface MeilisearchDocumentPayload {
  // Primary key (same as filePath)
  documentId: string;

  // File reference
  filePath: string;

  // MIME type from filesystem
  mimeType: string | null;

  // Searchable content fields (no chunking)
  content: string;        // Main file content
  summary: string | null; // AI-generated summary
  tags: string | null;    // Comma-separated tags

  // Content hash for deduplication
  contentHash: string;

  // Word count
  wordCount: number;

  // Type-specific metadata
  metadata?: Record<string, unknown>;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export interface QdrantPointPayload {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
