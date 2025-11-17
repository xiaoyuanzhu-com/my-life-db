/**
 * Qdrant Indexing Digester
 * Indexes file content for semantic vector search
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToQdrant } from '@/lib/search/ingest-to-qdrant';
import { enqueueQdrantIndex } from '@/lib/search/qdrant-tasks';
import { getQdrantDocumentIdsByFile } from '@/lib/db/qdrant-documents';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'QdrantSearchDigester' });

/**
 * Qdrant Indexing Digester
 * Indexes content for semantic vector search
 * Produces: search-qdrant
 */
export class QdrantSearchDigester implements Digester {
  readonly id = 'search-qdrant';
  readonly name = 'Qdrant Vector Indexer';
  readonly produces = ['search-qdrant'];
  readonly requires = ['content-md']; // Needs content to index

  async canDigest(
    filePath: string,
    _file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if content-md digest exists and is enriched
    const contentDigest = existingDigests.find((d) => d.digestType === 'content-md');

    if (!contentDigest || contentDigest.status !== 'enriched') {
      return false; // No content to index yet
    }

    // Check if we need to re-index (dependencies changed)
    const existingSearch = existingDigests.find((d) => d.digestType === 'search-qdrant');

    if (!existingSearch) {
      return true; // Never indexed
    }

    if (existingSearch.status === 'failed') {
      return true; // Retry failed indexing
    }

    // Check if dependencies were updated after we last indexed
    const summaryDigest = existingDigests.find((d) => d.digestType === 'summary');
    const tagsDigest = existingDigests.find((d) => d.digestType === 'tags');

    // Re-index if content changed
    if (contentDigest.updatedAt > existingSearch.updatedAt) {
      log.info({ filePath }, 'content-md updated, re-indexing');
      return true;
    }

    // Re-index if summary changed (and exists)
    if (summaryDigest && summaryDigest.status === 'enriched' && summaryDigest.updatedAt > existingSearch.updatedAt) {
      log.info({ filePath }, 'summary updated, re-indexing');
      return true;
    }

    // Re-index if tags changed (and exists)
    if (tagsDigest && tagsDigest.status === 'enriched' && tagsDigest.updatedAt > existingSearch.updatedAt) {
      log.info({ filePath }, 'tags updated, re-indexing');
      return true;
    }

    return false; // Already indexed and up to date
  }

  async digest(
    filePath: string,
    _file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<Digest[] | null> {
    log.info({ filePath }, 'indexing for qdrant');

    try {
      // Ingest to qdrant_documents table (creates chunks)
      const result = await ingestToQdrant(filePath);

      if (result.totalChunks === 0) {
        log.warn({ filePath }, 'no content to index');
        return null; // Skip this file
      }

      // Get all document IDs for this file
      const documentIds = getQdrantDocumentIdsByFile(filePath);

      if (documentIds.length === 0) {
        throw new Error('No Qdrant documents created after ingestion');
      }

      // Enqueue background task to generate embeddings and push to Qdrant
      const taskId = enqueueQdrantIndex(documentIds);

      if (!taskId) {
        throw new Error('Failed to enqueue Qdrant indexing task');
      }

      // Store metadata about indexing
      const now = new Date().toISOString();
      const metadata = {
        taskId,
        totalChunks: result.totalChunks,
        sources: result.sources,
        documentIds: documentIds.length,
        enqueuedAt: now,
      };

      log.info(
        { filePath, ...metadata },
        'qdrant indexing enqueued'
      );

      return [
        {
          id: generateDigestId(filePath, 'search-qdrant'),
          filePath,
          digestType: 'search-qdrant',
          status: 'enriched',
          content: JSON.stringify(metadata),
          sqlarName: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error({ filePath, error: errorMsg }, 'qdrant indexing failed');
      throw error; // Let coordinator handle error
    }
  }
}
