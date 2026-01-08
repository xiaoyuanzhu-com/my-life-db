/**
 * Keyword Search Indexing Digester
 * Indexes file content for keyword search
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToMeilisearch } from '~/.server/search/ingest-to-meilisearch';
import { indexInMeilisearch } from '~/.server/search/meili-indexer';
import { getMeiliDocumentIdForFile } from '~/.server/db/meili-documents';
import { getLogger } from '~/.server/log/logger';
import { getPrimaryTextContent } from '../utils/text-source';

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
  ): Promise<DigestInput[]> {
    const now = new Date().toISOString();

    // Check if we have any text content to index (for logging purposes)
    const textContent = await getPrimaryTextContent(filePath, file, existingDigests);

    log.debug(
      { filePath, source: textContent?.source ?? 'filename-only' },
      'indexing for keyword search'
    );

    // Always ingest to meili_documents table - even without text content,
    // we still want the file to be searchable by filename
    const result = await ingestToMeilisearch(filePath);

    // Get document ID
    const documentId = getMeiliDocumentIdForFile(filePath);

    // Index in Meilisearch (direct async call)
    log.debug({ filePath, documentId }, 'indexing in Meilisearch');
    await indexInMeilisearch([documentId]);

    // Store metadata about indexing
    const completedAt = new Date().toISOString();
    const metadata = {
      documentId,
      textSource: textContent?.source ?? 'filename-only',
      // Array of all content sources that contributed to indexing
      contentSources: result.contentSources,
      hasContent: result.hasContent,
      hasSummary: result.hasSummary,
      summarySource: result.summarySource,
      hasTags: result.hasTags,
      completedAt,
    };

    log.debug(
      { filePath, ...metadata },
      'keyword search indexing completed'
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
        updatedAt: completedAt,
      },
    ];
  }
}
