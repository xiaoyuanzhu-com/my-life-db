import 'server-only';
import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import {
  getQdrantDocumentById,
  updateEmbeddingStatus,
  batchUpdateEmbeddingStatus,
  type QdrantDocument,
} from '@/lib/db/qdrant-documents';
import { getDatabase } from '@/lib/db/connection';
import { getQdrantClient } from './qdrant-client';
import { embedTexts } from '@/lib/ai/embeddings';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'QdrantTasks' });

type QdrantIndexInput = { documentIds: string[] };
type QdrantDeleteInput = { documentIds: string[] };

const TASK_TYPES = {
  qdrant_index: 'qdrant_index',
  qdrant_delete: 'qdrant_delete',
} as const;

/**
 * Get current embedding schema version from environment
 */
function getEmbeddingVersion(): number {
  const raw = process.env.EMBEDDING_SCHEMA_VERSION;
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Enqueue documents for Qdrant indexing (vector embedding + upload)
 */
export function enqueueQdrantIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.qdrant_index]);
  return tq(TASK_TYPES.qdrant_index).add({ documentIds });
}

/**
 * Enqueue documents for Qdrant deletion
 */
export function enqueueQdrantDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.qdrant_delete]);
  return tq(TASK_TYPES.qdrant_delete).add({ documentIds });
}

/**
 * Index documents in Qdrant (task handler)
 *
 * This handler:
 * 1. Fetches chunks from qdrant_documents table
 * 2. Generates embeddings for chunk text
 * 3. Uploads vectors to Qdrant collection
 * 4. Updates embedding_status to 'indexed'
 */
defineTaskHandler({
  type: TASK_TYPES.qdrant_index,
  module: 'QdrantTasks',
  handler: async (input: QdrantIndexInput) => {
    const documentIds = deduplicate(input.documentIds);
    if (documentIds.length === 0) {
      return { count: 0, message: 'no documents to index' };
    }

    // Fetch documents from database
    const documents: QdrantDocument[] = [];
    for (const docId of documentIds) {
      const doc = getQdrantDocumentById(docId);
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
    batchUpdateEmbeddingStatus(documentIds, 'indexing', { error: undefined });

    try {
      // Generate embeddings (batch API call)
      log.info({ documentCount: documents.length }, 'generating embeddings');
      const texts = documents.map(doc => doc.chunkText);
      const embeddings = await embedTexts(texts);

      if (embeddings.length !== documents.length) {
        throw new Error(
          `Embedding count mismatch: expected ${documents.length}, got ${embeddings.length}`
        );
      }

      // Build Qdrant points
      const points = documents.map((doc, index) => ({
        id: doc.documentId,
        vector: embeddings[index].vector,
        payload: buildQdrantPayload(doc),
      }));

      // Upload to Qdrant
      log.info({ pointCount: points.length }, 'uploading vectors to Qdrant');
      const client = getQdrantClient();
      await client.upsert(points);

      // Update status to 'indexed'
      const now = new Date().toISOString();
      const embeddingVersion = getEmbeddingVersion();
      const db = getDatabase();

      for (const doc of documents) {
        updateEmbeddingStatus(doc.documentId, 'indexed', {
          pointId: doc.documentId, // Using document ID as point ID
          indexedAt: now,
          error: undefined,
        });

        // Also update embedding version in the document
        db.prepare(
          'UPDATE qdrant_documents SET embedding_version = ? WHERE document_id = ?'
        ).run(embeddingVersion, doc.documentId);
      }

      log.info(
        { documentCount: documents.length, embeddingVersion },
        'Qdrant indexing succeeded'
      );

      return {
        count: documents.length,
        embeddingVersion,
        message: 'indexing succeeded',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status to 'error'
      batchUpdateEmbeddingStatus(documentIds, 'error', { error: errorMessage });

      log.error(
        { err: error, documentCount: documents.length },
        'Qdrant indexing failed'
      );

      throw error;
    }
  },
});

/**
 * Delete documents from Qdrant (task handler)
 */
defineTaskHandler({
  type: TASK_TYPES.qdrant_delete,
  module: 'QdrantTasks',
  handler: async (input: QdrantDeleteInput) => {
    const documentIds = deduplicate(input.documentIds);
    if (documentIds.length === 0) {
      return { count: 0, message: 'no documents to delete' };
    }

    // Update status to 'deleting'
    batchUpdateEmbeddingStatus(documentIds, 'deleting', { error: undefined });

    try {
      // Delete from Qdrant
      const client = getQdrantClient();
      await client.delete(documentIds);

      log.info(
        { documentCount: documentIds.length },
        'Qdrant deletion succeeded'
      );

      // Update status to 'deleted'
      batchUpdateEmbeddingStatus(documentIds, 'deleted', {
        error: undefined,
      });

      return {
        count: documentIds.length,
        message: 'deletion succeeded',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update status to 'error'
      batchUpdateEmbeddingStatus(documentIds, 'error', { error: errorMessage });

      log.error(
        { err: error, documentCount: documentIds.length },
        'Qdrant deletion failed'
      );

      throw error;
    }
  },
});

/**
 * Build Qdrant payload from QdrantDocument
 * This is the metadata stored alongside the vector in Qdrant
 */
function buildQdrantPayload(doc: QdrantDocument): Record<string, unknown> {
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
    // File reference (file-centric)
    filePath: doc.filePath,
    sourceType: doc.sourceType,
    contentType: doc.contentType,

    // Chunking metadata
    chunkIndex: doc.chunkIndex,
    chunkCount: doc.chunkCount,
    text: doc.chunkText, // Full chunk text for display in search results

    // Span tracking
    spanStart: doc.spanStart,
    spanEnd: doc.spanEnd,
    overlapTokens: doc.overlapTokens,

    // Statistics
    wordCount: doc.wordCount,
    tokenCount: doc.tokenCount,

    // Additional metadata (title, tags, etc.)
    ...metadata,

    // Timestamps
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
