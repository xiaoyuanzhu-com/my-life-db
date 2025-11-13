import 'server-only';

/**
 * Chunk descriptor for text chunking operations
 */
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

/**
 * Unified document payload for Meilisearch
 * 1:1 file-to-document mapping with embedded digests
 */
export interface MeilisearchDocumentPayload {
  // Primary key (UUID for Meilisearch)
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
