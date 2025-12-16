import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getDigestByPathAndDigester, listDigestsForPath } from '~/.server/db/digests';
import { getFileByPath } from '~/.server/db/files';
import {
  upsertMeiliDocument,
  deleteMeiliDocumentByFilePath,
  getMeiliDocumentIdForFile,
} from '~/.server/db/meili-documents';
import { getLogger } from '~/.server/log/logger';
import { isTextFile } from '~/lib/file-types';

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

    // 1. Get main content (may be null for binary files - that's OK, we still index for filename search)
    const contentText = await getFileContent(filePath);

    // 2. Get summary (if exists from digest)
    const summaryDigest = digests.find(d => d.digester === 'url-crawl-summary' && d.status === 'completed');
    let summaryText: string | null = null;
    if (summaryDigest?.content) {
      try {
        const summaryData = JSON.parse(summaryDigest.content);
        summaryText = summaryData.summary || summaryDigest.content; // Fallback for old format
      } catch {
        // Fallback for old format (plain text)
        summaryText = summaryDigest.content;
      }
    }

    // 3. Get tags (if exists from digest)
    const tagsDigest = digests.find(d => d.digester === 'tags' && d.status === 'completed');
    let tagsText: string | null = null;
    if (tagsDigest?.content) {
      try {
        const tagsData = JSON.parse(tagsDigest.content);
        const tags = tagsData.tags || tagsData; // Handle both {tags: [...]} and plain [...]
        if (Array.isArray(tags) && tags.length > 0) {
          tagsText = tags.join(', ');
        }
      } catch (error) {
        log.warn({ filePath, error }, 'failed to parse tags digest');
      }
    }

    // Create single document with all content
    // Always index - even if no content, we still want filename searchable
    const hasContent = !!contentText;
    const allText = [contentText, summaryText, tagsText].filter(Boolean).join(' ');
    upsertMeiliDocument({
      filePath,
      content: contentText ?? '', // Empty string for binary files
      summary: summaryText,
      tags: tagsText,
      contentHash: allText ? hashString(allText) : hashString(filePath), // Use path hash if no content
      wordCount: contentText ? countWords(contentText) : 0,
      mimeType: fileRecord.mimeType,
    });

    log.debug(
      {
        filePath,
        hasContent,
        hasSummary: !!summaryText,
        hasTags: !!tagsText,
      },
      'ingested file to meilisearch'
    );

    return {
      documentId: filePath,
      hasContent,
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
 * 1. URL: Get from url-crawl-content digest
 * 2. Doc: Get from doc-to-markdown digest
 * 3. Image OCR: Get from image-ocr digest
 * 4. Image Caption: Get from image-captioning digest (fallback for images)
 * 5. Speech: Get from speech-recognition digest
 * 6. Library/Inbox file: Read from filesystem for text files
 */
async function getFileContent(filePath: string): Promise<string | null> {
  // 1. Check for URL digest first
  const contentDigest = getDigestByPathAndDigester(filePath, 'url-crawl-content');
  if (contentDigest?.content && contentDigest.status === 'completed') {
    // Parse JSON to get markdown
    try {
      const contentData = JSON.parse(contentDigest.content);
      return contentData.markdown || contentDigest.content; // Fallback for old format
    } catch {
      // Fallback for old format (plain markdown)
      return contentDigest.content;
    }
  }

  // 2. Check for doc-to-markdown digest
  const docDigest = getDigestByPathAndDigester(filePath, 'doc-to-markdown');
  if (docDigest?.content && docDigest.status === 'completed') {
    return docDigest.content;
  }

  // 3. Check for image-ocr digest
  const ocrDigest = getDigestByPathAndDigester(filePath, 'image-ocr');
  if (ocrDigest?.content && ocrDigest.status === 'completed') {
    return ocrDigest.content;
  }

  // 4. Check for image-captioning digest (fallback for images without OCR text)
  const captionDigest = getDigestByPathAndDigester(filePath, 'image-captioning');
  if (captionDigest?.content && captionDigest.status === 'completed') {
    return captionDigest.content;
  }

  // 5. Check for speech-recognition digest
  const speechDigest = getDigestByPathAndDigester(filePath, 'speech-recognition');
  if (speechDigest?.content && speechDigest.status === 'completed') {
    // Parse transcript JSON to extract plain text
    try {
      const transcriptData = JSON.parse(speechDigest.content);
      if (transcriptData.segments && Array.isArray(transcriptData.segments)) {
        return transcriptData.segments.map((s: { text: string }) => s.text).join(' ');
      }
      return speechDigest.content;
    } catch {
      return speechDigest.content;
    }
  }

  // 6. Read from filesystem for text files (using shared isTextFile utility)
  const fileRecord = getFileByPath(filePath);
  const filename = path.basename(filePath);
  if (isTextFile(fileRecord?.mimeType ?? null, filename)) {
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

  log.debug({ filePath, documentId }, 'deleted meilisearch document for file');

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
