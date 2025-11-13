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

export interface MeiliDocument {
  documentId: string;        // Same as filePath (1:1 mapping)
  filePath: string;          // e.g., 'inbox/article.md'
  content: string;           // Main file content
  summary: string | null;    // AI-generated summary (from digest)
  tags: string | null;       // Comma-separated tags (from digest)
  contentHash: string;       // SHA256 for change detection
  wordCount: number;         // Word count for stats
  mimeType: string | null;   // MIME type from filesystem
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
  content: string;
  summary: string | null;
  tags: string | null;
  content_hash: string;
  word_count: number;
  mime_type: string | null;
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
 * Get document by file path
 */
export function getMeiliDocumentByFilePath(filePath: string): MeiliDocument | null {
  return getMeiliDocumentById(filePath);
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
  filePath: string;
  content: string;
  summary?: string | null;
  tags?: string | null;
  contentHash: string;
  wordCount: number;
  mimeType?: string | null;
  metadataJson?: string | null;
}): MeiliDocument {
  const db = getDatabase();
  const now = new Date().toISOString();

  const existing = getMeiliDocumentById(doc.filePath);

  if (existing) {
    // Update existing document
    db.prepare(
      `UPDATE meili_documents SET
        content = ?,
        summary = ?,
        tags = ?,
        content_hash = ?,
        word_count = ?,
        mime_type = ?,
        metadata_json = ?,
        meili_status = 'pending',
        meili_error = NULL,
        updated_at = ?
      WHERE document_id = ?`
    ).run(
      doc.content,
      doc.summary ?? null,
      doc.tags ?? null,
      doc.contentHash,
      doc.wordCount,
      doc.mimeType ?? null,
      doc.metadataJson ?? null,
      now,
      doc.filePath
    );

    log.debug({ documentId: doc.filePath }, 'updated meili document');
  } else {
    // Insert new document
    db.prepare(
      `INSERT INTO meili_documents (
        document_id, file_path, content, summary, tags, content_hash,
        word_count, mime_type, metadata_json, meili_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      doc.filePath,
      doc.filePath,
      doc.content,
      doc.summary ?? null,
      doc.tags ?? null,
      doc.contentHash,
      doc.wordCount,
      doc.mimeType ?? null,
      doc.metadataJson ?? null,
      now,
      now
    );

    log.debug({ documentId: doc.filePath }, 'created meili document');
  }

  return getMeiliDocumentById(doc.filePath)!;
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
 * Delete document for a file
 */
export function deleteMeiliDocumentByFilePath(filePath: string): void {
  deleteMeiliDocument(filePath);
  log.debug({ filePath }, 'deleted meili document for file');
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
 * Get document ID for a file (1:1 mapping, so just returns filePath)
 */
export function getMeiliDocumentIdForFile(filePath: string): string {
  return filePath;
}
