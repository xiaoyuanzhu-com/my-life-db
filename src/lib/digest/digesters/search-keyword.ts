/**
 * Keyword Search Indexing Digester
 * Indexes file content for keyword search
 */

import type { Digester } from '../types';
import type { Digest, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToMeilisearch } from '@/lib/search/ingest-to-meilisearch';
import { enqueueMeiliIndex } from '@/lib/search/meili-tasks';
import { getMeiliDocumentIdForFile } from '@/lib/db/meili-documents';
import { generateDigestId } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import { hasAnyTextSource } from '@/lib/digest/text-source';

const log = getLogger({ module: 'SearchKeywordDigester' });

/**
 * Keyword Search Indexing Digester
 * Indexes content for full-text keyword search
 */
export class SearchKeywordDigester implements Digester {
  readonly name = 'search-keyword';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Process any text file regardless of size
    if (!hasAnyTextSource(file, existingDigests)) {
      return false;
    }

    // Check if we need to re-index (dependencies changed)
    const existingSearch = existingDigests.find((d) => d.digester === 'search-keyword');

    if (!existingSearch) {
      return true; // Never indexed
    }

    if (existingSearch.status === 'todo') {
      return true; // Not yet indexed
    }

    if (existingSearch.status === 'failed') {
      return true; // Retry failed indexing
    }

    // Check if dependencies were updated after we last indexed
    const summaryDigest =
      existingDigests.find((d) => d.digester === 'url-crawl-summary') ||
      existingDigests.find((d) => d.digester === 'summarize');
    const tagsDigest = existingDigests.find((d) => d.digester === 'tags');
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');

    // Re-index if content changed
    if (contentDigest && contentDigest.updatedAt > existingSearch.updatedAt) {
      log.info({ filePath }, 'url-crawl-content updated, re-indexing');
      return true;
    }

    // Re-index if summary changed (and exists)
    if (
      summaryDigest &&
      summaryDigest.status === 'completed' &&
      summaryDigest.updatedAt > existingSearch.updatedAt
    ) {
      log.info({ filePath }, 'summary updated, re-indexing');
      return true;
    }

    // Re-index if tags changed (and exists)
    if (tagsDigest && tagsDigest.status === 'completed' && tagsDigest.updatedAt > existingSearch.updatedAt) {
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
    log.info({ filePath }, 'indexing for keyword search');

    try {
      // Ingest to meili_documents table (creates/updates cache)
      const result = await ingestToMeilisearch(filePath);

      if (!result.hasContent) {
        log.warn({ filePath }, 'no content to index');
        return null; // Skip this file
      }

      // Get document ID
      const documentId = getMeiliDocumentIdForFile(filePath);

      // Enqueue background task to push to Meilisearch
      const taskId = enqueueMeiliIndex([documentId]);

      if (!taskId) {
        throw new Error('Failed to enqueue keyword search indexing task');
      }

      // Wait for indexing to complete (check meili_documents status)
      // Note: We return immediately here (fire-and-forget)
      // The meili_documents table tracks actual sync status
      const now = new Date().toISOString();

      // Store metadata about indexing
      const metadata = {
        documentId,
        taskId,
        hasContent: result.hasContent,
        hasSummary: result.hasSummary,
        hasTags: result.hasTags,
        enqueuedAt: now,
      };

      log.info(
        { filePath, ...metadata },
        'keyword search indexing enqueued'
      );

      return [
        {
          id: generateDigestId(filePath, 'search-keyword'),
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
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error({ filePath, error: errorMsg }, 'keyword search indexing failed');
      throw error; // Let coordinator handle error
    }
  }
}
