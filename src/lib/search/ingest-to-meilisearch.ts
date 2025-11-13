import 'server-only';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getDigestByPathAndType, listDigestsForPath } from '@/lib/db/digests';
import { getFileByPath } from '@/lib/db/files';
import {
  upsertMeiliDocument,
  deleteMeiliDocumentsByFile,
  getMeiliDocumentIdsByFile,
  type ContentType,
  type SourceType,
} from '@/lib/db/meili-documents';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'MeiliIngest' });

export interface MeiliIngestResult {
  documentIds: string[];
  counts: {
    content: number;
    summary: number;
    tags: number;
  };
}

/**
 * Ingest file content for Meilisearch indexing
 *
 * Creates full-text documents (no chunking) for keyword search.
 * Handles URL digests, library files, and inbox text.
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/article.md')
 * @returns Document IDs created for task queue
 */
export async function ingestToMeilisearch(filePath: string): Promise<MeiliIngestResult> {
  const documentIds: string[] = [];
  const counts = { content: 0, summary: 0, tags: 0 };

  try {
    // Get file metadata
    const fileRecord = getFileByPath(filePath);
    if (!fileRecord) {
      log.warn({ filePath }, 'file not found in files table');
      return { documentIds: [], counts };
    }

    // Determine content type
    const contentType = detectContentType(filePath, fileRecord.mimeType);

    // Get all digests for this file
    const digests = listDigestsForPath(filePath);

    // 1. Index main content
    const contentText = await getFileContent(filePath);
    if (contentText) {
      const docId = `${filePath}:content`;
      upsertMeiliDocument({
        documentId: docId,
        filePath,
        sourceType: 'content',
        fullText: contentText,
        contentHash: hashString(contentText),
        wordCount: countWords(contentText),
        contentType,
      });
      documentIds.push(docId);
      counts.content++;
      log.debug({ filePath, docId }, 'indexed content');
    }

    // 2. Index summary (if exists from digest)
    const summaryDigest = digests.find(d => d.digestType === 'summary' && d.status === 'enriched');
    if (summaryDigest?.content) {
      const docId = `${filePath}:summary`;
      upsertMeiliDocument({
        documentId: docId,
        filePath,
        sourceType: 'summary',
        fullText: summaryDigest.content,
        contentHash: hashString(summaryDigest.content),
        wordCount: countWords(summaryDigest.content),
        contentType,
      });
      documentIds.push(docId);
      counts.summary++;
      log.debug({ filePath, docId }, 'indexed summary');
    }

    // 3. Index tags (if exists from digest)
    const tagsDigest = digests.find(d => d.digestType === 'tags' && d.status === 'enriched');
    if (tagsDigest?.content) {
      try {
        const tags = JSON.parse(tagsDigest.content);
        if (Array.isArray(tags) && tags.length > 0) {
          const tagText = tags.join(', ');
          const docId = `${filePath}:tags`;
          upsertMeiliDocument({
            documentId: docId,
            filePath,
            sourceType: 'tags',
            fullText: tagText,
            contentHash: hashString(tagText),
            wordCount: tags.length,
            contentType,
          });
          documentIds.push(docId);
          counts.tags++;
          log.debug({ filePath, docId, tagCount: tags.length }, 'indexed tags');
        }
      } catch (error) {
        log.warn({ filePath, error }, 'failed to parse tags digest');
      }
    }

    log.info(
      {
        filePath,
        documentCount: documentIds.length,
        counts,
      },
      'ingested file to meilisearch'
    );

    return { documentIds, counts };
  } catch (error) {
    log.error(
      {
        err: error,
        filePath,
      },
      'failed to ingest file to meilisearch'
    );
    return { documentIds: [], counts };
  }
}

/**
 * Get file content for indexing
 *
 * Priority:
 * 1. URL: Get from digest/content-md
 * 2. Library/Inbox file: Read from filesystem
 */
async function getFileContent(filePath: string): Promise<string | null> {
  // Check for URL digest first
  const contentDigest = getDigestByPathAndType(filePath, 'content-md');
  if (contentDigest?.content && contentDigest.status === 'enriched') {
    return contentDigest.content;
  }

  // Read from filesystem for markdown/text files
  if (filePath.endsWith('.md') || filePath.endsWith('.txt')) {
    try {
      const dataDir = process.env.MY_DATA_DIR || './data';
      const fullPath = path.join(dataDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch (error) {
      log.warn({ filePath, error }, 'failed to read file from filesystem');
      return null;
    }
  }

  // For folders, try to read text.md
  const fileRecord = getFileByPath(filePath);
  if (fileRecord?.isFolder) {
    try {
      const dataDir = process.env.MY_DATA_DIR || './data';
      const textMdPath = path.join(dataDir, filePath, 'text.md');
      const content = await fs.readFile(textMdPath, 'utf-8');
      return content;
    } catch (error) {
      // text.md doesn't exist, that's ok
      return null;
    }
  }

  return null;
}

/**
 * Detect content type from file path and MIME type
 */
function detectContentType(filePath: string, mimeType: string | null): ContentType {
  // Check for URL digest
  const contentDigest = getDigestByPathAndType(filePath, 'content-md');
  if (contentDigest) {
    return 'url';
  }

  // Check MIME type
  if (mimeType) {
    if (mimeType.startsWith('text/')) return 'text';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'pdf';
  }

  // Check file extension
  if (filePath.endsWith('.md') || filePath.endsWith('.txt')) {
    return 'text';
  }
  if (filePath.endsWith('.pdf')) {
    return 'pdf';
  }
  if (/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(filePath)) {
    return 'image';
  }
  if (/\.(mp3|wav|ogg|m4a)$/i.test(filePath)) {
    return 'audio';
  }
  if (/\.(mp4|webm|mov|avi)$/i.test(filePath)) {
    return 'video';
  }

  return 'mixed';
}

/**
 * Delete all Meilisearch documents for a file
 */
export function deleteMeiliDocuments(filePath: string): string[] {
  const documentIds = getMeiliDocumentIdsByFile(filePath);
  deleteMeiliDocumentsByFile(filePath);

  log.info(
    {
      filePath,
      documentCount: documentIds.length,
    },
    'deleted meilisearch documents for file'
  );

  return documentIds;
}

/**
 * Re-index file (delete old, create new)
 */
export async function reindexMeilisearch(filePath: string): Promise<MeiliIngestResult> {
  deleteMeiliDocuments(filePath);
  return ingestToMeilisearch(filePath);
}

/**
 * Hash string with SHA256
 */
function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Count words in text (simple space-based count)
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).length;
}
