import 'server-only';
import { getDatabase } from '@/lib/db/connection';
import type {
  SearchDocumentInsert,
  SearchDocumentMetadata,
  SearchDocumentRecord,
  SearchDocumentSyncStatus,
  SearchVariant,
} from './types';

const TABLE = 'search_documents';

export function listDocumentIds(entryId: string, variant: SearchVariant): string[] {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT document_id FROM ${TABLE} WHERE entry_id = ? AND variant = ?`
  ).all(entryId, variant) as Array<{ document_id: string }>;
  return rows.map(row => row.document_id);
}

export function replaceSearchDocuments(params: {
  entryId: string;
  variant: SearchVariant;
  documents: SearchDocumentInsert[];
}): { insertedIds: string[] } {
  const db = getDatabase();
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    db.prepare(`DELETE FROM ${TABLE} WHERE entry_id = ? AND variant = ?`).run(
      params.entryId,
      params.variant
    );

    if (params.documents.length === 0) {
      return;
    }

    const insert = db.prepare(`
      INSERT INTO ${TABLE} (
        document_id,
        entry_id,
        library_id,
        source_url,
        source_path,
        variant,
        chunk_index,
        chunk_count,
        span_start,
        span_end,
        overlap_tokens,
        word_count,
        token_count,
        content_hash,
        chunk_text,
        metadata_json,
        meili_status,
        embedding_status,
        embedding_version,
        created_at,
        updated_at
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,
        'pending','pending',0,?,?
      );
    `);

    for (const doc of params.documents) {
      insert.run(
        doc.documentId,
        doc.entryId,
        doc.libraryId,
        doc.sourceUrl,
        doc.sourcePath,
        doc.variant,
        doc.chunkIndex,
        doc.chunkCount,
        doc.spanStart,
        doc.spanEnd,
        doc.overlapTokens,
        doc.wordCount,
        doc.tokenCount,
        doc.contentHash,
        doc.chunkText,
        JSON.stringify(doc.metadata ?? {}),
        now,
        now
      );
    }
  });

  transaction();
  return { insertedIds: params.documents.map(doc => doc.documentId) };
}

export function getDocumentsForEntry(
  entryId: string,
  variant?: SearchVariant
): SearchDocumentRecord[] {
  const db = getDatabase();
  let sql = `SELECT * FROM ${TABLE} WHERE entry_id = ?`;
  const params: (string | number)[] = [entryId];

  if (variant) {
    sql += ' AND variant = ?';
    params.push(variant);
  }

  sql += ' ORDER BY chunk_index ASC';
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function getDocumentsByIds(documentIds: string[]): SearchDocumentRecord[] {
  if (documentIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = documentIds.map(() => '?').join(',');
  const sql = `SELECT * FROM ${TABLE} WHERE document_id IN (${placeholders}) ORDER BY chunk_index ASC`;
  const rows = db.prepare(sql).all(...documentIds) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function markMeiliStatus(
  documentIds: string[],
  status: SearchDocumentSyncStatus,
  options?: {
    taskId?: string | number | null;
    error?: string | null;
    indexedAt?: string | null;
    deindexedAt?: string | null;
  }
): void {
  if (documentIds.length === 0) return;
  const db = getDatabase();
  const placeholders = documentIds.map(() => '?').join(',');
  const now = new Date().toISOString();

  const sql = `
    UPDATE ${TABLE}
    SET
      meili_status = ?,
      meili_task_id = ?,
      last_error = ?,
      last_indexed_at = COALESCE(?, last_indexed_at),
      last_deindexed_at = COALESCE(?, last_deindexed_at),
      updated_at = ?
    WHERE document_id IN (${placeholders})
  `;

  db.prepare(sql).run(
    status,
    options?.taskId ?? null,
    options?.error ?? null,
    options?.indexedAt ?? null,
    options?.deindexedAt ?? null,
    now,
    ...documentIds
  );
}

export function markEmbeddingStatus(
  documentIds: string[],
  status: SearchDocumentSyncStatus,
  options?: {
    error?: string | null;
    embeddedAt?: string | null;
    version?: number;
  }
): void {
  if (documentIds.length === 0) return;
  const db = getDatabase();
  const placeholders = documentIds.map(() => '?').join(',');
  const now = new Date().toISOString();

  const sql = `
    UPDATE ${TABLE}
    SET
      embedding_status = ?,
      last_error = ?,
      last_embedded_at = COALESCE(?, last_embedded_at),
      embedding_version = COALESCE(?, embedding_version),
      updated_at = ?
    WHERE document_id IN (${placeholders})
  `;

  db.prepare(sql).run(
    status,
    options?.error ?? null,
    options?.embeddedAt ?? null,
    options?.version ?? null,
    now,
    ...documentIds
  );
}

function rowToRecord(row: Record<string, unknown>): SearchDocumentRecord {
  return {
    documentId: row.document_id as string,
    entryId: row.entry_id as string,
    libraryId: (row.library_id as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    sourcePath: row.source_path as string,
    variant: row.variant as SearchVariant,
    chunkIndex: row.chunk_index as number,
    chunkCount: row.chunk_count as number,
    spanStart: row.span_start as number,
    spanEnd: row.span_end as number,
    overlapTokens: row.overlap_tokens as number,
    wordCount: row.word_count as number,
    tokenCount: row.token_count as number,
    contentHash: row.content_hash as string,
    chunkText: row.chunk_text as string,
    metadata: parseMetadata(row.metadata_json as string | null),
    meiliStatus: row.meili_status as SearchDocumentSyncStatus,
    meiliTaskId: (row.meili_task_id as string) ?? null,
    lastIndexedAt: (row.last_indexed_at as string) ?? null,
    lastDeindexedAt: (row.last_deindexed_at as string) ?? null,
    embeddingStatus: row.embedding_status as SearchDocumentSyncStatus,
    embeddingVersion: (row.embedding_version as number) ?? 0,
    lastEmbeddedAt: (row.last_embedded_at as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function parseMetadata(value: string | null): SearchDocumentMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as SearchDocumentMetadata;
    }
  } catch {
    return {};
  }
  return {};
}
