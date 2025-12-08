/**
 * Keyword Search Indexing Digester
 * Indexes file content for keyword search
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { ingestToMeilisearch } from '@/lib/search/ingest-to-meilisearch';
import { enqueueMeiliIndex } from '@/lib/search/meili-tasks';
import { getMeiliDocumentIdForFile } from '@/lib/db/meili-documents';
import { getLogger } from '@/lib/log/logger';
import { hasAnyTextSource } from '@/lib/digest/text-source';

const log = getLogger({ module: 'SearchKeywordDigester' });
const toTimestamp = (value?: string | null) => value ? new Date(value).getTime() : 0;

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
    return this.needsIndexing(filePath, file, existingDigests);
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    log.debug({ filePath }, 'indexing for keyword search');

    // Check if we have any text source - throw error if not
    if (!hasAnyTextSource(file, existingDigests)) {
      throw new Error('No text source available for indexing');
    }

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
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error({ filePath, error: errorMsg }, 'keyword search indexing failed');
      throw error; // Let coordinator handle error
    }
  }

  async shouldReprocessCompleted(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[]
  ): Promise<boolean> {
    const existingSearch = existingDigests.find((d) => d.digester === 'search-keyword');
    if (!existingSearch || (existingSearch.status !== 'completed' && existingSearch.status !== 'skipped')) {
      return false;
    }

    return this.needsIndexing(filePath, file, existingDigests);
  }

  private needsIndexing(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[]
  ): boolean {
    // Process any text file regardless of size
    if (!hasAnyTextSource(file, existingDigests)) {
      return false;
    }

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

    const lastIndexed = toTimestamp(existingSearch.updatedAt);
    const summaryDigest =
      existingDigests.find((d) => d.digester === 'url-crawl-summary') ||
      existingDigests.find((d) => d.digester === 'summarize');
    const tagsDigest = existingDigests.find((d) => d.digester === 'tags');
    const contentDigest = existingDigests.find((d) => d.digester === 'url-crawl-content');
    const docDigest = existingDigests.find((d) => d.digester === 'doc-to-markdown');
    const ocrDigest = existingDigests.find((d) => d.digester === 'image-ocr');
    const fileUpdatedAt = toTimestamp(file.modified_at);

    // Re-index if content changed
    if (contentDigest && toTimestamp(contentDigest.updatedAt) > lastIndexed) {
      log.debug({ filePath }, 'url-crawl-content updated, re-indexing');
      return true;
    }

    // Re-index if doc-to-markdown content changed
    if (docDigest && toTimestamp(docDigest.updatedAt) > lastIndexed) {
      log.debug({ filePath }, 'doc-to-markdown content updated, re-indexing');
      return true;
    }

    // Re-index if image-ocr content changed
    if (ocrDigest && toTimestamp(ocrDigest.updatedAt) > lastIndexed) {
      log.debug({ filePath }, 'image-ocr content updated, re-indexing');
      return true;
    }

    // Re-index if summary changed (and exists)
    if (
      summaryDigest &&
      summaryDigest.status === 'completed' &&
      toTimestamp(summaryDigest.updatedAt) > lastIndexed
    ) {
      log.debug({ filePath }, 'summary updated, re-indexing');
      return true;
    }

    // Re-index if tags changed (and exists)
    if (
      tagsDigest &&
      tagsDigest.status === 'completed' &&
      toTimestamp(tagsDigest.updatedAt) > lastIndexed
    ) {
      log.debug({ filePath }, 'tags updated, re-indexing');
      return true;
    }

    // Re-index if file changed and we rely on local text content
    if (!contentDigest && !docDigest && !ocrDigest && fileUpdatedAt > lastIndexed) {
      log.debug({ filePath }, 'file modified after last keyword index, re-indexing');
      return true;
    }

    return false; // Already indexed and up to date
  }
}
