import 'server-only';
import { tq } from '@/lib/task-queue';
import { getDocumentsByIds } from './search-documents';
import { indexDocumentsInMeilisearch, deleteDocumentsFromMeilisearch } from './meili-indexer';
import { indexVectorsForDocuments, deleteVectorsFromQdrant } from './vector-ingestor';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SearchTasks' });
let handlersRegistered = false;

type DocumentTaskInput = { documentIds: string[] };

type TaskName =
  | 'search_index'
  | 'search_delete'
  | 'search_vector_index'
  | 'search_vector_delete';

const TASK_TYPE_MAP: Record<TaskName, { primary: string; legacy?: string }> = {
  search_index: { primary: 'search_index', legacy: 'search.index' },
  search_delete: { primary: 'search_delete', legacy: 'search.delete' },
  search_vector_index: { primary: 'search_vector_index', legacy: 'search.vector.index' },
  search_vector_delete: { primary: 'search_vector_delete', legacy: 'search.vector.delete' },
};

export function enqueueSearchIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureHandlersRegistered();
  return tq(TASK_TYPE_MAP.search_index.primary).add({ documentIds });
}

export function enqueueSearchDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureHandlersRegistered();
  return tq(TASK_TYPE_MAP.search_delete.primary).add({ documentIds });
}

export function enqueueVectorIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureHandlersRegistered();
  return tq(TASK_TYPE_MAP.search_vector_index.primary).add({ documentIds });
}

export function enqueueVectorDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureHandlersRegistered();
  return tq(TASK_TYPE_MAP.search_vector_delete.primary).add({ documentIds });
}

export function registerSearchTaskHandlers(): void {
  ensureHandlersRegistered();
}

function ensureHandlersRegistered(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  setupHandlers();
  log.info({}, 'search task handlers registered');
}

function setupHandlers(): void {
  registerHandler('search_index', async (input) => {
    const docs = getDocumentsByIds(deduplicate(input.documentIds));
    await indexDocumentsInMeilisearch(docs);
    return { count: docs.length };
  });

  registerHandler('search_vector_index', async (input) => {
    await indexVectorsForDocuments(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });

  registerHandler('search_delete', async (input) => {
    await deleteDocumentsFromMeilisearch(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });

  registerHandler('search_vector_delete', async (input) => {
    await deleteVectorsFromQdrant(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  });
}

function registerHandler(
  taskName: TaskName,
  handler: (input: DocumentTaskInput) => Promise<unknown>
) {
  const config = TASK_TYPE_MAP[taskName];
  const names = [config.primary, config.legacy].filter(Boolean) as string[];
  for (const name of names) {
    tq(name).setWorker(handler);
  }
}

function deduplicate(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}
