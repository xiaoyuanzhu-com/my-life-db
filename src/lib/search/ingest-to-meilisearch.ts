import 'server-only';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getDigestByPathAndDigester, listDigestsForPath } from '@/lib/db/digests';
import { getFileByPath } from '@/lib/db/files';
import {
  upsertMeiliDocument,
  deleteMeiliDocumentByFilePath,
  getMeiliDocumentIdForFile,
} from '@/lib/db/meili-documents';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'MeiliIngest' });

export interface MeiliIngestResult {
  documentId: string;
  hasContent: boolean;
  hasSummary: boolean;
  hasTags: boolean;
}

/**
 * Ingest file content for Meilisearch indexing
 *
 * Creates a single full-text document (no chunking) for keyword search.
 * Embeds summary and tags from digests into the document.
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/article.md')
 * @returns Document ID created for task queue
 */
export async function ingestToMeilisearch(filePath: string): Promise<MeiliIngestResult> {
  try {
    // Get file metadata
    const fileRecord = getFileByPath(filePath);
    if (!fileRecord) {
      log.warn({ filePath }, 'file not found in files table');
      return { documentId: filePath, hasContent: false, hasSummary: false, hasTags: false };
    }

    // Get all digests for this file
    const digests = listDigestsForPath(filePath);

    // 1. Get main content
    const contentText = await getFileContent(filePath);
    if (!contentText) {
      log.warn({ filePath }, 'no content found for file');
      return { documentId: filePath, hasContent: false, hasSummary: false, hasTags: false };
    }

    // 2. Get summary (if exists from digest)
    const summaryDigest = digests.find(d => d.digester === 'summarize' && d.status === 'completed');
    const summaryText = summaryDigest?.content || null;

    // 3. Get tags (if exists from digest)
    const tagsDigest = digests.find(d => d.digester === 'tagging' && d.status === 'completed');
    let tagsText: string | null = null;
    if (tagsDigest?.content) {
      try {
        const tags = JSON.parse(tagsDigest.content);
        if (Array.isArray(tags) && tags.length > 0) {
          tagsText = tags.join(', ');
        }
      } catch (error) {
        log.warn({ filePath, error }, 'failed to parse tags digest');
      }
    }

    // Create single document with all content
    const allText = [contentText, summaryText, tagsText].filter(Boolean).join(' ');
    upsertMeiliDocument({
      filePath,
      content: contentText,
      summary: summaryText,
      tags: tagsText,
      contentHash: hashString(allText),
      wordCount: countWords(contentText),
      mimeType: fileRecord.mimeType,
    });

    log.info(
      {
        filePath,
        hasContent: true,
        hasSummary: !!summaryText,
        hasTags: !!tagsText,
      },
      'ingested file to meilisearch'
    );

    return {
      documentId: filePath,
      hasContent: true,
      hasSummary: !!summaryText,
      hasTags: !!tagsText,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        filePath,
      },
      'failed to ingest file to meilisearch'
    );
    return { documentId: filePath, hasContent: false, hasSummary: false, hasTags: false };
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
  const contentDigest = getDigestByPathAndDigester(filePath, 'url-crawl-content');
  if (contentDigest?.content && contentDigest.status === 'completed') {
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
    } catch {
      // text.md doesn't exist, that's ok
      return null;
    }
  }

  return null;
}

/**
 * Delete Meilisearch document for a file
 */
export function deleteMeiliDocument(filePath: string): string {
  const documentId = getMeiliDocumentIdForFile(filePath);
  deleteMeiliDocumentByFilePath(filePath);

  log.info({ filePath, documentId }, 'deleted meilisearch document for file');

  return documentId;
}

/**
 * Re-index file (delete old, create new)
 */
export async function reindexMeilisearch(filePath: string): Promise<MeiliIngestResult> {
  deleteMeiliDocument(filePath);
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
