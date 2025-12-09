import 'server-only';
import { tq } from '~/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '~/lib/task-queue/handler-registry';
import {
  getMeiliDocumentById,
  batchUpdateMeiliStatus,
  type MeiliDocument,
} from '~/lib/db/meili-documents';
import { getMeiliClient } from './meili-client';
import { getLogger } from '~/lib/log/logger';

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

type MeiliIndexInput = { documentIds: string[] };
type MeiliDeleteInput = { documentIds: string[] };

const TASK_TYPES = {
  meili_index: 'meili_index',
  meili_delete: 'meili_delete',
} as const;

/**
 * Enqueue documents for Meilisearch indexing
 */
export function enqueueMeiliIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.meili_index]);
  return tq(TASK_TYPES.meili_index).add({ documentIds });
}

/**
 * Enqueue documents for Meilisearch deletion
 */
export function enqueueMeiliDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.meili_delete]);
  return tq(TASK_TYPES.meili_delete).add({ documentIds });
}

/**
 * Index documents in Meilisearch (task handler)
 */
defineTaskHandler({
  type: TASK_TYPES.meili_index,
  module: 'MeiliTasks',
  handler: async (input: MeiliIndexInput) => {
    const documentIds = deduplicate(input.documentIds);
    if (documentIds.length === 0) {
      return { count: 0, message: 'no documents to index' };
    }

    // Fetch documents from database
    const documents: MeiliDocument[] = [];
    for (const docId of documentIds) {
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
    batchUpdateMeiliStatus(documentIds, 'indexing');

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
        batchUpdateMeiliStatus(documentIds, 'indexed', {
          taskId: String(taskUid),
        });

        log.debug(
          { taskUid, documentCount: documents.length },
          'Meilisearch indexing succeeded'
        );

        return {
          count: documents.length,
          taskUid,
          message: 'indexing succeeded',
        };
      }

      // Task failed
      const errorMessage = task.error?.message ?? 'unknown Meilisearch task failure';
      batchUpdateMeiliStatus(documentIds, 'error', {
        taskId: String(taskUid),
        error: errorMessage,
      });

      throw new Error(errorMessage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status to 'error'
      batchUpdateMeiliStatus(documentIds, 'error', { error: errorMessage });

      log.error(
        { err: error, documentCount: documents.length },
        'Meilisearch indexing failed'
      );

      throw error;
    }
  },
});

/**
 * Delete documents from Meilisearch (task handler)
 */
defineTaskHandler({
  type: TASK_TYPES.meili_delete,
  module: 'MeiliTasks',
  handler: async (input: MeiliDeleteInput) => {
    const documentIds = deduplicate(input.documentIds);
    if (documentIds.length === 0) {
      return { count: 0, message: 'no documents to delete' };
    }

    // Update status to 'deleting'
    batchUpdateMeiliStatus(documentIds, 'deleting');

    try {
      // Get Meilisearch client
      const client = await getMeiliClient();

      // Delete from Meilisearch
      const taskUid = await client.deleteDocuments(documentIds);

      if (taskUid === 0) {
        // No task created (empty batch)
        batchUpdateMeiliStatus(documentIds, 'deleted');
        return { count: 0, message: 'no documents deleted (empty batch)' };
      }

      log.debug(
        { taskUid, documentCount: documentIds.length },
        'submitted delete to Meilisearch'
      );

      // Wait for Meilisearch task to complete
      const task = await client.waitForTask(taskUid, { timeoutMs: 60_000 });

      if (task.status === 'succeeded') {
        // Update status to 'deleted'
        batchUpdateMeiliStatus(documentIds, 'deleted', {
          taskId: String(taskUid),
        });

        log.debug(
          { taskUid, documentCount: documentIds.length },
          'Meilisearch deletion succeeded'
        );

        return {
          count: documentIds.length,
          taskUid,
          message: 'deletion succeeded',
        };
      }

      // Task failed
      const errorMessage = task.error?.message ?? 'Meilisearch delete task failed';
      batchUpdateMeiliStatus(documentIds, 'error', {
        taskId: String(taskUid),
        error: errorMessage,
      });

      throw new Error(errorMessage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status to 'error'
      batchUpdateMeiliStatus(documentIds, 'error', { error: errorMessage });

      log.error(
        { err: error, documentCount: documentIds.length },
        'Meilisearch deletion failed'
      );

      throw error;
    }
  },
});

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
