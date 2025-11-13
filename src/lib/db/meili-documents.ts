/**
 * Meilisearch document operations
 *
 * The meili_documents table stores full-text documents for Meilisearch indexing.
 * Each file can have multiple documents (content, summary, tags).
 * Documents are rebuildable from filesystem + digests.
 */

import { getDatabase } from './connection';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DBMeiliDocuments' });

export type MeiliStatus = 'pending' | 'indexing' | 'indexed' | 'deleting' | 'deleted' | 'error';
export type SourceType = 'content' | 'summary' | 'tags';
export type ContentType = 'url' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'mixed';

export interface MeiliDocument {
  documentId: string;        // e.g., 'inbox/article.md:content'
  filePath: string;          // e.g., 'inbox/article.md'
  sourceType: SourceType;    // 'content' | 'summary' | 'tags'
  fullText: string;          // Complete document text (no chunking)
  contentHash: string;       // SHA256 for change detection
  wordCount: number;         // Word count for stats
  contentType: ContentType;  // 'url' | 'text' | 'pdf' | etc.
  metadataJson: string | null; // Additional context
  meiliStatus: MeiliStatus;  // Sync status
  meiliTaskId: string | null; // Meilisearch task ID
  meiliIndexedAt: string | null; // ISO timestamp
  meiliError: string | null; // Error message if failed
  createdAt: string;         // ISO timestamp
  updatedAt: string;         // ISO timestamp
}

interface MeiliDocumentRow {
  document_id: string;
  file_path: string;
  source_type: SourceType;
  full_text: string;
  content_hash: string;
  word_count: number;
  content_type: ContentType;
  metadata_json: string | null;
  meili_status: MeiliStatus;
  meili_task_id: string | null;
  meili_indexed_at: string | null;
  meili_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMeiliDocument(row: MeiliDocumentRow): MeiliDocument {
  return {
    documentId: row.document_id,
    filePath: row.file_path,
    sourceType: row.source_type,
    fullText: row.full_text,
    contentHash: row.content_hash,
    wordCount: row.word_count,
    contentType: row.content_type,
    metadataJson: row.metadata_json,
    meiliStatus: row.meili_status,
    meiliTaskId: row.meili_task_id,
    meiliIndexedAt: row.meili_indexed_at,
    meiliError: row.meili_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get document by ID
 */
export function getMeiliDocumentById(documentId: string): MeiliDocument | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM meili_documents WHERE document_id = ?')
    .get(documentId) as MeiliDocumentRow | undefined;

  return row ? rowToMeiliDocument(row) : null;
}

/**
 * List documents for a file
 */
export function listMeiliDocumentsByFile(filePath: string): MeiliDocument[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM meili_documents WHERE file_path = ? ORDER BY source_type')
    .all(filePath) as MeiliDocumentRow[];

  return rows.map(rowToMeiliDocument);
}

/**
 * List documents by status
 */
export function listMeiliDocumentsByStatus(
  status: MeiliStatus,
  limit?: number
): MeiliDocument[] {
  const db = getDatabase();
  const query = limit
    ? 'SELECT * FROM meili_documents WHERE meili_status = ? LIMIT ?'
    : 'SELECT * FROM meili_documents WHERE meili_status = ?';

  const params = limit ? [status, limit] : [status];
  const rows = db.prepare(query).all(...params) as MeiliDocumentRow[];

  return rows.map(rowToMeiliDocument);
}

/**
 * Create or update meili document
 */
export function upsertMeiliDocument(doc: {
  documentId: string;
  filePath: string;
  sourceType: SourceType;
  fullText: string;
  contentHash: string;
  wordCount: number;
  contentType: ContentType;
  metadataJson?: string | null;
}): MeiliDocument {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = getMeiliDocumentById(doc.documentId);

  if (existing) {
    // Update existing document
    db.prepare(
      `UPDATE meili_documents SET
        file_path = ?,
        source_type = ?,
        full_text = ?,
        content_hash = ?,
        word_count = ?,
        content_type = ?,
        metadata_json = ?,
        meili_status = 'pending',
        meili_error = NULL,
        updated_at = ?
      WHERE document_id = ?`
    ).run(
      doc.filePath,
      doc.sourceType,
      doc.fullText,
      doc.contentHash,
      doc.wordCount,
      doc.contentType,
      doc.metadataJson ?? null,
      now,
      doc.documentId
    );

    log.debug({ documentId: doc.documentId }, 'updated meili document');
  } else {
    // Insert new document
    db.prepare(
      `INSERT INTO meili_documents (
        document_id, file_path, source_type, full_text, content_hash,
        word_count, content_type, metadata_json, meili_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      doc.documentId,
      doc.filePath,
      doc.sourceType,
      doc.fullText,
      doc.contentHash,
      doc.wordCount,
      doc.contentType,
      doc.metadataJson ?? null,
      now,
      now
    );

    log.debug({ documentId: doc.documentId }, 'created meili document');
  }

  return getMeiliDocumentById(doc.documentId)!;
}

/**
 * Update meili status
 */
export function updateMeiliStatus(
  documentId: string,
  status: MeiliStatus,
  options?: {
    taskId?: string;
    error?: string;
  }
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  const updates: string[] = ['meili_status = ?', 'updated_at = ?'];
  const params: (string | null)[] = [status, now];

  if (options?.taskId) {
    updates.push('meili_task_id = ?');
    params.push(options.taskId);
  }

  if (options?.error) {
    updates.push('meili_error = ?');
    params.push(options.error);
  } else if (status === 'indexed') {
    // Clear error on successful index
    updates.push('meili_error = NULL');
  }

  if (status === 'indexed') {
    updates.push('meili_indexed_at = ?');
    params.push(now);
  }

  params.push(documentId);

  db.prepare(
    `UPDATE meili_documents SET ${updates.join(', ')} WHERE document_id = ?`
  ).run(...params);

  log.debug({ documentId, status }, 'updated meili status');
}

/**
 * Batch update meili status
 */
export function batchUpdateMeiliStatus(
  documentIds: string[],
  status: MeiliStatus,
  options?: {
    taskId?: string;
    error?: string;
  }
): void {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    for (const documentId of documentIds) {
      updateMeiliStatus(documentId, status, options);
    }
  });

  transaction();
  log.debug({ count: documentIds.length, status }, 'batch updated meili status');
}

/**
 * Delete documents for a file
 */
export function deleteMeiliDocumentsByFile(filePath: string): number {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM meili_documents WHERE file_path = ?')
    .run(filePath);

  log.debug({ filePath, count: result.changes }, 'deleted meili documents for file');
  return result.changes;
}

/**
 * Delete document by ID
 */
export function deleteMeiliDocument(documentId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM meili_documents WHERE document_id = ?').run(documentId);

  log.debug({ documentId }, 'deleted meili document');
}

/**
 * Count documents by status
 */
export function countMeiliDocumentsByStatus(status: MeiliStatus): number {
  const db = getDatabase();
  const row = db
    .prepare('SELECT COUNT(*) as count FROM meili_documents WHERE meili_status = ?')
    .get(status) as { count: number };

  return row.count;
}

/**
 * Get all document IDs for a file
 */
export function getMeiliDocumentIdsByFile(filePath: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT document_id FROM meili_documents WHERE file_path = ?')
    .all(filePath) as { document_id: string }[];

  return rows.map(r => r.document_id);
}
