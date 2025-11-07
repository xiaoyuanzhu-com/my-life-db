import 'server-only';
import { tq } from '@/lib/task-queue';
import { getDocumentsByIds } from './search-documents';
import { indexDocumentsInMeilisearch, deleteDocumentsFromMeilisearch } from './meili-indexer';
import { indexVectorsForDocuments, deleteVectorsFromQdrant } from './vector-ingestor';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SearchTasks' });

type DocumentTaskInput = { documentIds: string[] };

export function enqueueSearchIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  return tq('search.index').add({ documentIds });
}

export function enqueueSearchDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  return tq('search.delete').add({ documentIds });
}

export function enqueueVectorIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  return tq('search.vector.index').add({ documentIds });
}

export function enqueueVectorDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  return tq('search.vector.delete').add({ documentIds });
}

export function registerSearchTaskHandlers(): void {
  tq('search.index').setWorker(async (input: DocumentTaskInput) => {
    const docs = getDocumentsByIds(deduplicate(input.documentIds));
    await indexDocumentsInMeilisearch(docs);
    return { count: docs.length };
  });

  tq('search.vector.index').setWorker(async (input: DocumentTaskInput) => {
    await indexVectorsForDocuments(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });

  tq('search.delete').setWorker(async (input: DocumentTaskInput) => {
    await deleteDocumentsFromMeilisearch(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });

  tq('search.vector.delete').setWorker(async (input: DocumentTaskInput) => {
    await deleteVectorsFromQdrant(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });

  log.info({}, 'search task handlers registered');
}

function deduplicate(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
