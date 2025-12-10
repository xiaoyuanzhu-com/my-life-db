/**
 * Semantic Search Indexing Digester
 * Indexes file content for semantic vector search
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToQdrant } from '~/lib/search/ingest-to-qdrant';
import { enqueueQdrantIndex } from '~/lib/search/qdrant-tasks';
import { getQdrantDocumentIdsByFile } from '~/lib/db/qdrant-documents';
import { getLogger } from '~/lib/log/logger';
import { getPrimaryTextContent } from '~/lib/digest/text-source';

const log = getLogger({ module: 'SearchSemanticDigester' });

/**
 * Semantic Search Indexing Digester
 * Indexes content for semantic vector search
 *
 * Always runs for all file types. Completes with content if text available,
 * completes with null content if no text available (never skips).
 * Cascading resets from upstream digesters trigger re-indexing.
 */
export class SearchSemanticDigester implements Digester {
  readonly name = 'search-semantic';
  readonly label = 'Semantic Search';
  readonly description = 'Generate embeddings for semantic vector search in Qdrant';

  async canDigest(
    _filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Always try to run for non-folder files
    // Cascading resets handle re-processing when content becomes available
    return !file.is_folder;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    const now = new Date().toISOString();

    // Check if we have any text content to index
    const textContent = await getPrimaryTextContent(filePath, file, existingDigests);

    if (!textContent) {
      // No text available - complete with no content (don't skip)
      // Cascading resets will trigger re-processing if content becomes available
      log.debug({ filePath }, 'no text content available for semantic search');
      return [
        {
          filePath,
          digester: 'search-semantic',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    log.debug({ filePath, source: textContent.source }, 'indexing for semantic search');

    // Ingest to qdrant_documents table (creates chunks)
    const result = await ingestToQdrant(filePath);

    if (result.totalChunks === 0) {
      // Ingestion returned no chunks (shouldn't happen if getPrimaryTextContent returned text)
      log.warn({ filePath }, 'ingestToQdrant returned no chunks');
      return [
        {
          filePath,
          digester: 'search-semantic',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    // Get all document IDs for this file
    const documentIds = getQdrantDocumentIdsByFile(filePath);

    if (documentIds.length === 0) {
      throw new Error('No semantic search documents created after ingestion');
    }

    // Enqueue background task to generate embeddings and push to Qdrant
    const taskId = enqueueQdrantIndex(documentIds);

    if (!taskId) {
      throw new Error('Failed to enqueue semantic search indexing task');
    }

    // Store metadata about indexing
    const metadata = {
      taskId,
      textSource: textContent.source,
      totalChunks: result.totalChunks,
      sources: result.sources,
      documentIds: documentIds.length,
      enqueuedAt: now,
    };

    log.debug(
      { filePath, ...metadata },
      'semantic search indexing enqueued'
    );

    return [
      {
        filePath,
        digester: 'search-semantic',
        status: 'completed',
        content: JSON.stringify(metadata),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
