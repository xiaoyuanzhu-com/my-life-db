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
  // Note: This mapper is for the old search_documents table structure
  // The new system uses meili-tasks.ts with the meili_documents table
  // This code is kept for backward compatibility during migration
  const metadata = doc.metadata ?? {};
  return {
    documentId: doc.documentId,
    filePath: doc.sourcePath,
    mimeType: metadata.mimeType as string | null ?? null,
    content: doc.chunkText,
    summary: null,
    tags: null,
    contentHash: doc.contentHash,
    wordCount: doc.wordCount,
    metadata,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
