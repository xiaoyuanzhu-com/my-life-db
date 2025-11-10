import 'server-only';
import { getMeiliClient } from './meili-client';
import { markMeiliStatus } from './search-documents';
import type { MeilisearchDocumentPayload, SearchDocumentRecord } from './types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'MeiliIndexer' });

export async function indexDocumentsInMeilisearch(
  documents: SearchDocumentRecord[]
): Promise<void> {
  if (documents.length === 0) {
    return;
  }

  const client = await getMeiliClient();
  const documentIds = documents.map(doc => doc.documentId);
  const payload = documents.map(mapToPayload);

  markMeiliStatus(documentIds, 'indexing', { error: null });

  try {
    const taskUid = await client.addDocuments(payload);
    const task = await client.waitForTask(taskUid);

    if (task.status === 'succeeded') {
      markMeiliStatus(documentIds, 'indexed', {
        taskId: taskUid,
        error: null,
        indexedAt: new Date().toISOString(),
      });
      log.info(
        { taskUid, documentCount: documents.length },
        'meilisearch indexing succeeded'
      );
      return;
    }

    const message = task.error?.message ?? 'unknown meilisearch task failure';
    markMeiliStatus(documentIds, 'error', {
      taskId: taskUid,
      error: message,
    });
    throw new Error(message);
  } catch (error) {
    markMeiliStatus(documentIds, 'error', { error: (error as Error).message });
    log.error(
      { err: error, count: documents.length },
      'meilisearch indexing failed'
    );
    throw error;
  }
}

export async function deleteDocumentsFromMeilisearch(documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  const client = await getMeiliClient();

  try {
    const taskUid = await client.deleteDocuments(documentIds);
    if (taskUid === 0) return;

    const task = await client.waitForTask(taskUid);
    if (task.status !== 'succeeded') {
      const message = task.error?.message ?? 'meilisearch delete task failed';
      throw new Error(message);
    }
    log.info({ taskUid, count: documentIds.length }, 'meilisearch delete completed');
  } catch (error) {
    log.error({ err: error, count: documentIds.length }, 'meilisearch delete failed');
    throw error;
  }
}

function mapToPayload(doc: SearchDocumentRecord): MeilisearchDocumentPayload {
  const metadata = doc.metadata ?? {};
  return {
    docId: doc.documentId,
    entryId: doc.entryId,
    libraryId: doc.libraryId,
    contentType: doc.contentType,
    variant: doc.variant,
    text: doc.chunkText,
    sourcePath: doc.sourcePath,
    url: metadata.url ?? doc.sourceUrl ?? null,
    hostname: metadata.hostname ?? null,
    chunkIndex: doc.chunkIndex,
    chunkCount: doc.chunkCount,
    checksum: doc.contentHash,
    overlapTokens: doc.overlapTokens,
    metadata,
    capturedAt: metadata.capturedAt ?? doc.createdAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
