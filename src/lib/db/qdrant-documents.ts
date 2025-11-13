/**
 * Qdrant document operations
 *
 * The qdrant_documents table stores chunked documents for Qdrant vector search.
 * Each file is split into chunks (800-1000 tokens) with overlap for context preservation.
 * Documents are rebuildable from filesystem + digests.
 */

import { getDatabase } from './connection';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DBQdrantDocuments' });

export type EmbeddingStatus = 'pending' | 'indexing' | 'indexed' | 'deleting' | 'deleted' | 'error';
export type SourceType = 'content' | 'summary' | 'tags';
export type ContentType = 'url' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'mixed';

export interface QdrantDocument {
  documentId: string;        // e.g., 'inbox/article.md:content:0'
  filePath: string;          // e.g., 'inbox/article.md'
  sourceType: SourceType;    // 'content' | 'summary' | 'tags'
  chunkIndex: number;        // 0-based chunk index
  chunkCount: number;        // Total chunks for this file+source
  chunkText: string;         // 800-1000 tokens of text
  spanStart: number;         // Character position start in original
  spanEnd: number;           // Character position end in original
  overlapTokens: number;     // Number of overlapping tokens from previous chunk
  wordCount: number;         // Word count for stats
  tokenCount: number;        // Token count for stats
  contentHash: string;       // SHA256 for change detection
  contentType: ContentType;  // 'url' | 'text' | 'pdf' | etc.
  metadataJson: string | null; // Additional context
  embeddingStatus: EmbeddingStatus; // Sync status
  embeddingVersion: number;  // Embedding model version
  qdrantPointId: string | null; // UUID in Qdrant collection
  qdrantIndexedAt: string | null; // ISO timestamp
  qdrantError: string | null; // Error message if failed
  createdAt: string;         // ISO timestamp
  updatedAt: string;         // ISO timestamp
}

interface QdrantDocumentRow {
  document_id: string;
  file_path: string;
  source_type: SourceType;
  chunk_index: number;
  chunk_count: number;
  chunk_text: string;
  span_start: number;
  span_end: number;
  overlap_tokens: number;
  word_count: number;
  token_count: number;
  content_hash: string;
  content_type: ContentType;
  metadata_json: string | null;
  embedding_status: EmbeddingStatus;
  embedding_version: number;
  qdrant_point_id: string | null;
  qdrant_indexed_at: string | null;
  qdrant_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToQdrantDocument(row: QdrantDocumentRow): QdrantDocument {
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
    contentType: row.content_type,
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

/**
 * Get document by ID
 */
export function getQdrantDocumentById(documentId: string): QdrantDocument | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM qdrant_documents WHERE document_id = ?')
    .get(documentId) as QdrantDocumentRow | undefined;

  return row ? rowToQdrantDocument(row) : null;
}

/**
 * List chunks for a file (all source types)
 */
export function listQdrantDocumentsByFile(filePath: string): QdrantDocument[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM qdrant_documents WHERE file_path = ? ORDER BY source_type, chunk_index')
    .all(filePath) as QdrantDocumentRow[];

  return rows.map(rowToQdrantDocument);
}

/**
 * List chunks for a file + source type
 */
export function listQdrantDocumentsByFileAndSource(
  filePath: string,
  sourceType: SourceType
): QdrantDocument[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM qdrant_documents WHERE file_path = ? AND source_type = ? ORDER BY chunk_index')
    .all(filePath, sourceType) as QdrantDocumentRow[];

  return rows.map(rowToQdrantDocument);
}

/**
 * List documents by embedding status
 */
export function listQdrantDocumentsByStatus(
  status: EmbeddingStatus,
  limit?: number
): QdrantDocument[] {
  const db = getDatabase();
  const query = limit
    ? 'SELECT * FROM qdrant_documents WHERE embedding_status = ? LIMIT ?'
    : 'SELECT * FROM qdrant_documents WHERE embedding_status = ?';

  const params = limit ? [status, limit] : [status];
  const rows = db.prepare(query).all(...params) as QdrantDocumentRow[];

  return rows.map(rowToQdrantDocument);
}

/**
 * Create or update qdrant document
 */
export function upsertQdrantDocument(doc: {
  documentId: string;
  filePath: string;
  sourceType: SourceType;
  chunkIndex: number;
  chunkCount: number;
  chunkText: string;
  spanStart: number;
  spanEnd: number;
  overlapTokens: number;
  wordCount: number;
  tokenCount: number;
  contentHash: string;
  contentType: ContentType;
  metadataJson?: string | null;
  embeddingVersion?: number;
}): QdrantDocument {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = getQdrantDocumentById(doc.documentId);

  if (existing) {
    // Update existing document
    db.prepare(
      `UPDATE qdrant_documents SET
        file_path = ?,
        source_type = ?,
        chunk_index = ?,
        chunk_count = ?,
        chunk_text = ?,
        span_start = ?,
        span_end = ?,
        overlap_tokens = ?,
        word_count = ?,
        token_count = ?,
        content_hash = ?,
        content_type = ?,
        metadata_json = ?,
        embedding_status = 'pending',
        embedding_version = ?,
        qdrant_error = NULL,
        updated_at = ?
      WHERE document_id = ?`
    ).run(
      doc.filePath,
      doc.sourceType,
      doc.chunkIndex,
      doc.chunkCount,
      doc.chunkText,
      doc.spanStart,
      doc.spanEnd,
      doc.overlapTokens,
      doc.wordCount,
      doc.tokenCount,
      doc.contentHash,
      doc.contentType,
      doc.metadataJson ?? null,
      doc.embeddingVersion ?? 0,
      now,
      doc.documentId
    );

    log.debug({ documentId: doc.documentId }, 'updated qdrant document');
  } else {
    // Insert new document
    db.prepare(
      `INSERT INTO qdrant_documents (
        document_id, file_path, source_type, chunk_index, chunk_count,
        chunk_text, span_start, span_end, overlap_tokens, word_count,
        token_count, content_hash, content_type, metadata_json,
        embedding_status, embedding_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      doc.documentId,
      doc.filePath,
      doc.sourceType,
      doc.chunkIndex,
      doc.chunkCount,
      doc.chunkText,
      doc.spanStart,
      doc.spanEnd,
      doc.overlapTokens,
      doc.wordCount,
      doc.tokenCount,
      doc.contentHash,
      doc.contentType,
      doc.metadataJson ?? null,
      doc.embeddingVersion ?? 0,
      now,
      now
    );

    log.debug({ documentId: doc.documentId }, 'created qdrant document');
  }

  return getQdrantDocumentById(doc.documentId)!;
}

/**
 * Update embedding status
 */
export function updateEmbeddingStatus(
  documentId: string,
  status: EmbeddingStatus,
  options?: {
    pointId?: string;
    error?: string;
    indexedAt?: string;
  }
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  const updates: string[] = ['embedding_status = ?', 'updated_at = ?'];
  const params: (string | null)[] = [status, now];

  if (options?.pointId) {
    updates.push('qdrant_point_id = ?');
    params.push(options.pointId);
  }

  if (options?.error) {
    updates.push('qdrant_error = ?');
    params.push(options.error);
  } else if (status === 'indexed') {
    // Clear error on successful index
    updates.push('qdrant_error = NULL');
  }

  if (status === 'indexed') {
    updates.push('qdrant_indexed_at = ?');
    params.push(options?.indexedAt ?? now);
  }

  params.push(documentId);

  db.prepare(
    `UPDATE qdrant_documents SET ${updates.join(', ')} WHERE document_id = ?`
  ).run(...params);

  log.debug({ documentId, status }, 'updated embedding status');
}

/**
 * Batch update embedding status
 */
export function batchUpdateEmbeddingStatus(
  documentIds: string[],
  status: EmbeddingStatus,
  options?: {
    pointId?: string;
    error?: string;
    indexedAt?: string;
  }
): void {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    for (const documentId of documentIds) {
      updateEmbeddingStatus(documentId, status, options);
    }
  });

  transaction();
  log.debug({ count: documentIds.length, status }, 'batch updated embedding status');
}

/**
 * Delete all chunks for a file
 */
export function deleteQdrantDocumentsByFile(filePath: string): number {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM qdrant_documents WHERE file_path = ?')
    .run(filePath);

  log.debug({ filePath, count: result.changes }, 'deleted qdrant documents for file');
  return result.changes;
}

/**
 * Delete document by ID
 */
export function deleteQdrantDocument(documentId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM qdrant_documents WHERE document_id = ?').run(documentId);

  log.debug({ documentId }, 'deleted qdrant document');
}

/**
 * Count documents by status
 */
export function countQdrantDocumentsByStatus(status: EmbeddingStatus): number {
  const db = getDatabase();
  const row = db
    .prepare('SELECT COUNT(*) as count FROM qdrant_documents WHERE embedding_status = ?')
    .get(status) as { count: number };

  return row.count;
}

/**
 * Get all document IDs for a file
 */
export function getQdrantDocumentIdsByFile(filePath: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT document_id FROM qdrant_documents WHERE file_path = ? ORDER BY source_type, chunk_index')
    .all(filePath) as { document_id: string }[];

  return rows.map(r => r.document_id);
}

/**
 * Get all document IDs for a file + source type
 */
export function getQdrantDocumentIdsByFileAndSource(
  filePath: string,
  sourceType: SourceType
): string[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT document_id FROM qdrant_documents WHERE file_path = ? AND source_type = ? ORDER BY chunk_index')
    .all(filePath, sourceType) as { document_id: string }[];

  return rows.map(r => r.document_id);
}
