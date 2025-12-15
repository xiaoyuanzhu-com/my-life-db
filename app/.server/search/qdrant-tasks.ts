import { randomUUID } from 'crypto';
import { tq } from '~/.server/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '~/.server/task-queue/handler-registry';
import {
  getQdrantDocumentById,
  updateEmbeddingStatus,
  batchUpdateEmbeddingStatus,
  type QdrantDocument,
} from '~/.server/db/qdrant-documents';
import { getQdrantClient, ensureQdrantCollection } from './qdrant-client';
import { embedTexts } from '~/.server/ai/embeddings';
import { getLogger } from '~/.server/log/logger';

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
      log.debug({ documentCount: documents.length }, 'generating embeddings');
      const texts = documents.map(doc => doc.chunkText);
      const embeddings = await embedTexts(texts);

      if (embeddings.length !== documents.length) {
        throw new Error(
          `Embedding count mismatch: expected ${documents.length}, got ${embeddings.length}`
        );
      }

      // Build Qdrant points - generate UUIDs for point IDs if not already set
      const points = documents.map((doc, index) => {
        // Generate or reuse UUID for Qdrant point ID
        // Qdrant requires point IDs to be either UUIDs or unsigned integers
        const pointId = doc.qdrantPointId || randomUUID();

        return {
          id: pointId,
          vector: embeddings[index].vector,
          payload: buildQdrantPayload(doc),
        };
      });

      // Ensure collection exists (will create if needed)
      const vectorSize = embeddings[0].vector.length;
      await ensureQdrantCollection(vectorSize);

      // Upload to Qdrant
      log.debug({ pointCount: points.length }, 'uploading vectors to Qdrant');
      const client = await getQdrantClient();
      await client.upsert(points);

      // Update status to 'indexed'
      const now = new Date().toISOString();
      const embeddingVersion = getEmbeddingVersion();

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const pointId = points[i].id;

        updateEmbeddingStatus(doc.documentId, 'indexed', {
          pointId, // Store the UUID used in Qdrant
          indexedAt: now,
          error: undefined,
          embeddingVersion,
        });
      }

      log.debug(
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

    // Fetch documents to get their Qdrant point IDs
    const pointIds: string[] = [];
    for (const docId of documentIds) {
      const doc = getQdrantDocumentById(docId);
      if (doc?.qdrantPointId) {
        pointIds.push(doc.qdrantPointId);
      } else {
        log.debug({ documentId: docId }, 'document has no Qdrant point ID, skipping');
      }
    }

    // Update status to 'deleting'
    batchUpdateEmbeddingStatus(documentIds, 'deleting', { error: undefined });

    try {
      // Delete from Qdrant using point IDs (not document IDs)
      if (pointIds.length > 0) {
        const client = await getQdrantClient();
        await client.delete(pointIds);
      }

      log.debug(
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
