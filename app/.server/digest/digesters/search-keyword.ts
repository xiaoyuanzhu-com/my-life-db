/**
 * Keyword Search Indexing Digester
 * Indexes file content for keyword search
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToMeilisearch } from '~/.server/search/ingest-to-meilisearch';
import { enqueueMeiliIndex } from '~/.server/search/meili-tasks';
import { getMeiliDocumentIdForFile } from '~/.server/db/meili-documents';
import { getLogger } from '~/.server/log/logger';
import { getPrimaryTextContent } from '~/.server/digest/text-source';

const log = getLogger({ module: 'SearchKeywordDigester' });

/**
 * Keyword Search Indexing Digester
 * Indexes content for full-text keyword search
 *
 * Always runs for all file types. Completes with content if text available,
 * completes with null content if no text available (never skips).
 * Cascading resets from upstream digesters trigger re-indexing.
 */
export class SearchKeywordDigester implements Digester {
  readonly name = 'search-keyword';
  readonly label = 'Keyword Search';
  readonly description = 'Index content for full-text keyword search in Meilisearch';

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
      log.debug({ filePath }, 'no text content available for keyword search');
      return [
        {
          filePath,
          digester: 'search-keyword',
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

    log.debug({ filePath, source: textContent.source }, 'indexing for keyword search');

    // Ingest to meili_documents table (creates/updates cache)
    const result = await ingestToMeilisearch(filePath);

    if (!result.hasContent) {
      // Ingestion returned no content (shouldn't happen if getPrimaryTextContent returned text)
      log.warn({ filePath }, 'ingestToMeilisearch returned no content');
      return [
        {
          filePath,
          digester: 'search-keyword',
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

    // Get document ID
    const documentId = getMeiliDocumentIdForFile(filePath);

    // Enqueue background task to push to Meilisearch
    const taskId = enqueueMeiliIndex([documentId]);

    if (!taskId) {
      throw new Error('Failed to enqueue keyword search indexing task');
    }

    // Store metadata about indexing
    const metadata = {
      documentId,
      taskId,
      textSource: textContent.source,
      hasContent: result.hasContent,
      hasSummary: result.hasSummary,
      hasTags: result.hasTags,
      enqueuedAt: now,
    };

    log.debug(
      { filePath, ...metadata },
      'keyword search indexing enqueued'
    );

    return [
      {
        filePath,
        digester: 'search-keyword',
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
