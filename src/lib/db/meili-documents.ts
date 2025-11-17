/**
 * Meilisearch document operations
 *
 * The meili_documents table stores full-text documents for Meilisearch indexing.
 * 1:1 file-to-document mapping (one document per file).
 * Documents are rebuildable from filesystem + digests.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from './connection';
import { getLogger } from '@/lib/log/logger';
import type { MeiliDocument, MeiliDocumentRow, MeiliStatus } from '@/types/models';
import { rowToMeiliDocument } from '@/types/models';

const log = getLogger({ module: 'DBMeiliDocuments' });

// Re-export types for convenience
export type { MeiliDocument, MeiliDocumentRow, MeiliStatus };

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
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM meili_documents WHERE file_path = ?')
    .get(filePath) as MeiliDocumentRow | undefined;

  return row ? rowToMeiliDocument(row) : null;
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

  // Check if document already exists for this file path
  const existing = getMeiliDocumentByFilePath(doc.filePath);

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
      existing.documentId
    );

    log.debug({ documentId: existing.documentId, filePath: doc.filePath }, 'updated meili document');
    return getMeiliDocumentById(existing.documentId)!;
  } else {
    // Insert new document with a fresh UUID
    const documentId = randomUUID();
    db.prepare(
      `INSERT INTO meili_documents (
        document_id, file_path, content, summary, tags, content_hash,
        word_count, mime_type, metadata_json, meili_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      documentId,
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

    log.debug({ documentId, filePath: doc.filePath }, 'created meili document');
    return getMeiliDocumentById(documentId)!;
  }
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
  const doc = getMeiliDocumentByFilePath(filePath);
  if (doc) {
    deleteMeiliDocument(doc.documentId);
    log.debug({ documentId: doc.documentId, filePath }, 'deleted meili document for file');
  }
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
 * Get document ID for a file path
 *
 * @param filePath - Relative file path (e.g., 'inbox/article.md')
 * @returns Document ID (UUID) if document exists, or throws error
 */
export function getMeiliDocumentIdForFile(filePath: string): string {
  const doc = getMeiliDocumentByFilePath(filePath);
  if (!doc) {
    throw new Error(`No Meilisearch document found for file: ${filePath}`);
  }
  return doc.documentId;
}
