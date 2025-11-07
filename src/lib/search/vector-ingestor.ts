import 'server-only';
import { embedTexts } from '@/lib/ai/embeddings';
import { getQdrantClient } from './qdrant-client';
import { getDocumentsByIds, markEmbeddingStatus } from './search-documents';
import type { SearchDocumentRecord } from './types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'VectorIngest' });

export function getEmbeddingSchemaVersion(): number {
  const raw = process.env.EMBEDDING_SCHEMA_VERSION;
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function indexVectorsForDocuments(documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;

  const documents = getDocumentsByIds(documentIds);
  if (documents.length === 0) {
    log.warn({ documentIds }, 'no documents found for vector indexing');
    return;
  }

  markEmbeddingStatus(documentIds, 'indexing', { error: null });

  try {
    const embeddings = await embedTexts(documents.map(doc => doc.chunkText));
    if (embeddings.length !== documents.length) {
      throw new Error('Embedding count mismatch');
    }

    const points = documents.map((doc, index) => ({
      id: doc.documentId,
      vector: embeddings[index].vector,
      payload: buildPayload(doc),
    }));

    const client = getQdrantClient();
    await client.upsert(points);

    markEmbeddingStatus(documentIds, 'indexed', {
      version: getEmbeddingSchemaVersion(),
      embeddedAt: new Date().toISOString(),
      error: null,
    });

    log.info({ count: points.length }, 'qdrant upsert completed');
  } catch (error) {
    markEmbeddingStatus(documentIds, 'error', { error: (error as Error).message });
    log.error({ err: error }, 'vector indexing failed');
    throw error;
  }
}

export async function deleteVectorsFromQdrant(documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  const client = getQdrantClient();

  try {
    await client.delete(documentIds);
    log.info({ count: documentIds.length }, 'qdrant delete completed');
  } catch (error) {
    log.error({ err: error, count: documentIds.length }, 'qdrant delete failed');
    throw error;
  }
}

function buildPayload(doc: SearchDocumentRecord): Record<string, unknown> {
  const metadata = doc.metadata ?? {};
  return {
    entryId: doc.entryId,
    libraryId: doc.libraryId,
    url: metadata.url ?? doc.sourceUrl ?? null,
    hostname: metadata.hostname ?? null,
    tags: metadata.tags ?? [],
    digestPath: metadata.digestPath ?? null,
    screenshotPath: metadata.screenshotPath ?? null,
    variant: doc.variant,
    chunkIndex: doc.chunkIndex,
    chunkCount: doc.chunkCount,
    spanStart: doc.spanStart,
    spanEnd: doc.spanEnd,
    overlapTokens: doc.overlapTokens,
    tokenCount: doc.tokenCount,
    capturedAt: metadata.capturedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
