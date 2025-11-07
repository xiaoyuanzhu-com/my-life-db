import 'server-only';

export type SearchVariant = 'url-content-md' | 'url-content-html' | 'url-summary';

export type SearchDocumentSyncStatus =
  | 'pending'
  | 'indexing'
  | 'indexed'
  | 'deleting'
  | 'deleted'
  | 'error';

export interface SearchDocumentMetadata {
  title?: string | null;
  description?: string | null;
  author?: string | null;
  tags?: string[];
  digestPath?: string | null;
  screenshotPath?: string | null;
  url?: string | null;
  hostname?: string | null;
  path?: string | null;
  capturedAt?: string | null;
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
  meiliStatus: SearchDocumentSyncStatus;
  meiliTaskId: string | null;
  lastIndexedAt: string | null;
  lastDeindexedAt: string | null;
  embeddingStatus: SearchDocumentSyncStatus;
  embeddingVersion: number;
  lastEmbeddedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchDocumentInsert {
  documentId: string;
  entryId: string;
  libraryId: string | null;
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

export interface MeilisearchDocumentPayload {
  docId: string;
  entryId: string;
  libraryId?: string | null;
  url: string | null;
  hostname: string | null;
  path: string | null;
  sourcePath: string;
  variant: SearchVariant;
  chunkIndex: number;
  chunkCount: number;
  checksum: string;
  overlapTokens: number;
  text: string;
  metadata: SearchDocumentMetadata;
  capturedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QdrantPointPayload {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
