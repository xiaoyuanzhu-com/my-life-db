/**
 * Meilisearch indexing functions
 * Direct async calls (no task queue)
 */

import {
  getMeiliDocumentById,
  batchUpdateMeiliStatus,
  type MeiliDocument,
} from '~/.server/db/meili-documents';
import { getMeiliClient } from './meili-client';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'MeiliTasks' });

/**
 * Meilisearch document payload for indexing
 * 1:1 file-to-document mapping with embedded digests
 */
export interface MeiliSearchPayload {
  // Primary key in Meilisearch (same as filePath)
  documentId: string;

  // File reference (file-centric architecture)
  filePath: string;

  // MIME type from filesystem
  mimeType: string | null;

  // Searchable content fields
  content: string;           // Main file content
  summary: string | null;    // AI-generated summary
  tags: string | null;       // Comma-separated tags

  // Content hash for deduplication
  contentHash: string;

  // Word count
  wordCount: number;

  // Optional metadata
  metadata?: Record<string, unknown>;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/**
 * Index documents in Meilisearch
 * Direct async function - throws on failure
 */
export async function indexInMeilisearch(documentIds: string[]): Promise<{
  count: number;
  message: string;
}> {
  const uniqueIds = deduplicate(documentIds);
  if (uniqueIds.length === 0) {
    return { count: 0, message: 'no documents to index' };
  }

  // Fetch documents from database
  const documents: MeiliDocument[] = [];
  for (const docId of uniqueIds) {
    const doc = getMeiliDocumentById(docId);
    if (doc) {
      documents.push(doc);
    } else {
      log.warn({ documentId: docId }, 'document not found for indexing');
    }
  }

  if (documents.length === 0) {
    return { count: 0, message: 'no valid documents found' };
  }

  // Update status to 'indexing'
  batchUpdateMeiliStatus(uniqueIds, 'indexing');

  try {
    // Get Meilisearch client
    const client = await getMeiliClient();

    // Convert to Meilisearch payload
    const payload = documents.map(mapToMeiliPayload);

    // Index in Meilisearch
    const taskUid = await client.addDocuments(payload);
    log.debug(
      { taskUid, documentCount: documents.length },
      'submitted documents to Meilisearch'
    );

    // Wait for Meilisearch task to complete
    const task = await client.waitForTask(taskUid, { timeoutMs: 60_000 });

    if (task.status === 'succeeded') {
      // Update status to 'indexed'
      batchUpdateMeiliStatus(uniqueIds, 'indexed', {
        taskId: String(taskUid),
      });

      log.debug(
        { taskUid, documentCount: documents.length },
        'Meilisearch indexing succeeded'
      );

      return {
        count: documents.length,
        message: 'indexing succeeded',
      };
    }

    // Task failed
    const errorMessage = task.error?.message ?? 'unknown Meilisearch task failure';
    batchUpdateMeiliStatus(uniqueIds, 'error', {
      taskId: String(taskUid),
      error: errorMessage,
    });

    throw new Error(errorMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Update status to 'error'
    batchUpdateMeiliStatus(uniqueIds, 'error', { error: errorMessage });

    log.error(
      { err: error, documentCount: documents.length },
      'Meilisearch indexing failed'
    );

    throw error;
  }
}

/**
 * Delete documents from Meilisearch
 * Direct async function - throws on failure
 */
export async function deleteFromMeilisearch(documentIds: string[]): Promise<{
  count: number;
  message: string;
}> {
  const uniqueIds = deduplicate(documentIds);
  if (uniqueIds.length === 0) {
    return { count: 0, message: 'no documents to delete' };
  }

  // Update status to 'deleting'
  batchUpdateMeiliStatus(uniqueIds, 'deleting');

  try {
    // Get Meilisearch client
    const client = await getMeiliClient();

    // Delete from Meilisearch
    const taskUid = await client.deleteDocuments(uniqueIds);

    if (taskUid === 0) {
      // No task created (empty batch)
      batchUpdateMeiliStatus(uniqueIds, 'deleted');
      return { count: 0, message: 'no documents deleted (empty batch)' };
    }

    log.debug(
      { taskUid, documentCount: uniqueIds.length },
      'submitted delete to Meilisearch'
    );

    // Wait for Meilisearch task to complete
    const task = await client.waitForTask(taskUid, { timeoutMs: 60_000 });

    if (task.status === 'succeeded') {
      // Update status to 'deleted'
      batchUpdateMeiliStatus(uniqueIds, 'deleted', {
        taskId: String(taskUid),
      });

      log.debug(
        { taskUid, documentCount: uniqueIds.length },
        'Meilisearch deletion succeeded'
      );

      return {
        count: uniqueIds.length,
        message: 'deletion succeeded',
      };
    }

    // Task failed
    const errorMessage = task.error?.message ?? 'Meilisearch delete task failed';
    batchUpdateMeiliStatus(uniqueIds, 'error', {
      taskId: String(taskUid),
      error: errorMessage,
    });

    throw new Error(errorMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Update status to 'error'
    batchUpdateMeiliStatus(uniqueIds, 'error', { error: errorMessage });

    log.error(
      { err: error, documentCount: uniqueIds.length },
      'Meilisearch deletion failed'
    );

    throw error;
  }
}

/**
 * Convert MeiliDocument to Meilisearch payload
 */
function mapToMeiliPayload(doc: MeiliDocument): MeiliSearchPayload {
  let metadata: Record<string, unknown> = {};
  if (doc.metadataJson) {
    try {
      metadata = JSON.parse(doc.metadataJson);
    } catch (error) {
      log.warn(
        { documentId: doc.documentId, error },
        'failed to parse metadata JSON'
      );
    }
  }

  return {
    documentId: doc.documentId,
    filePath: doc.filePath,
    mimeType: doc.mimeType,
    content: doc.content,
    summary: doc.summary,
    tags: doc.tags,
    contentHash: doc.contentHash,
    wordCount: doc.wordCount,
    metadata,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Deduplicate and filter empty document IDs
 */
function deduplicate(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
