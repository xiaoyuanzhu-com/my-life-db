import 'server-only';
import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getDocumentsByIds } from './search-documents';
import { indexDocumentsInMeilisearch, deleteDocumentsFromMeilisearch } from './meili-indexer';
import { indexVectorsForDocuments, deleteVectorsFromQdrant } from './vector-ingestor';

type DocumentTaskInput = { documentIds: string[] };

const TASK_TYPES = {
  search_index: 'search_index',
  search_delete: 'search_delete',
  search_vector_index: 'search_vector_index',
  search_vector_delete: 'search_vector_delete',
} as const;

export function enqueueSearchIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.search_index]);
  return tq(TASK_TYPES.search_index).add({ documentIds });
}

export function enqueueSearchDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.search_delete]);
  return tq(TASK_TYPES.search_delete).add({ documentIds });
}

export function enqueueVectorIndex(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.search_vector_index]);
  return tq(TASK_TYPES.search_vector_index).add({ documentIds });
}

export function enqueueVectorDelete(documentIds: string[]): string | null {
  if (!documentIds || documentIds.length === 0) return null;
  ensureTaskRuntimeReady([TASK_TYPES.search_vector_delete]);
  return tq(TASK_TYPES.search_vector_delete).add({ documentIds });
}

function deduplicate(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

defineTaskHandler({
  type: TASK_TYPES.search_index,
  module: 'SearchTasks',
  handler: async (input: DocumentTaskInput) => {
    const docs = getDocumentsByIds(deduplicate(input.documentIds));
    await indexDocumentsInMeilisearch(docs);
    return { count: docs.length };
  },
});

defineTaskHandler({
  type: TASK_TYPES.search_vector_index,
  module: 'SearchTasks',
  handler: async (input: DocumentTaskInput) => {
    await indexVectorsForDocuments(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  },
});

defineTaskHandler({
  type: TASK_TYPES.search_delete,
  module: 'SearchTasks',
  handler: async (input: DocumentTaskInput) => {
    await deleteDocumentsFromMeilisearch(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  },
});

defineTaskHandler({
  type: TASK_TYPES.search_vector_delete,
  module: 'SearchTasks',
  handler: async (input: DocumentTaskInput) => {
    await deleteVectorsFromQdrant(deduplicate(input.documentIds));
    return { count: input.documentIds.length };
  },
});
