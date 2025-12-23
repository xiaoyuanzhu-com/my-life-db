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
  summarySource: string | null;
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
      return { documentId: filePath, hasContent: false, hasSummary: false, summarySource: null, hasTags: false };
    }

    // Get all digests for this file
    const digests = listDigestsForPath(filePath);

    // 1. Get main content (may be null for binary files - that's OK, we still index for filename search)
    const contentText = await getFileContent(filePath);

    // 2. Get summary (if exists from digest)
    // Check url-crawl-summary first, then speech-recognition-summary
    let summaryText: string | null = null;
    let summarySource: string | null = null;
    const urlSummaryDigest = digests.find(d => d.digester === 'url-crawl-summary' && d.status === 'completed');
    const speechSummaryDigest = digests.find(d => d.digester === 'speech-recognition-summary' && d.status === 'completed');

    if (urlSummaryDigest?.content) {
      summarySource = 'url-crawl-summary';
      try {
        const summaryData = JSON.parse(urlSummaryDigest.content);
        summaryText = summaryData.summary || urlSummaryDigest.content;
      } catch {
        summaryText = urlSummaryDigest.content;
      }
    } else if (speechSummaryDigest?.content) {
      summarySource = 'speech-recognition-summary';
      try {
        const summaryData = JSON.parse(speechSummaryDigest.content);
        summaryText = summaryData.summary || speechSummaryDigest.content;
      } catch {
        summaryText = speechSummaryDigest.content;
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
      summarySource,
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
    return { documentId: filePath, hasContent: false, hasSummary: false, summarySource: null, hasTags: false };
  }
}

/**
 * Get file content for indexing
 *
 * Collects content from all applicable sources and combines them:
 * - URL: url-crawl-content digest
 * - Doc: doc-to-markdown digest
 * - Image: Both image-ocr AND image-captioning (combined)
 * - Speech: speech-recognition digest
 * - Text files: Read from filesystem
 */
async function getFileContent(filePath: string): Promise<string | null> {
  const contentParts: string[] = [];

  // 1. Check for URL digest
  const contentDigest = getDigestByPathAndDigester(filePath, 'url-crawl-content');
  if (contentDigest?.content && contentDigest.status === 'completed') {
    try {
      const contentData = JSON.parse(contentDigest.content);
      contentParts.push(contentData.markdown || contentDigest.content);
    } catch {
      contentParts.push(contentDigest.content);
    }
  }

  // 2. Check for doc-to-markdown digest
  const docDigest = getDigestByPathAndDigester(filePath, 'doc-to-markdown');
  if (docDigest?.content && docDigest.status === 'completed') {
    contentParts.push(docDigest.content);
  }

  // 3. Check for image-ocr digest
  const ocrDigest = getDigestByPathAndDigester(filePath, 'image-ocr');
  if (ocrDigest?.content && ocrDigest.status === 'completed') {
    contentParts.push(ocrDigest.content);
  }

  // 4. Check for image-captioning digest (always include, not just fallback)
  const captionDigest = getDigestByPathAndDigester(filePath, 'image-captioning');
  if (captionDigest?.content && captionDigest.status === 'completed') {
    contentParts.push(captionDigest.content);
  }

  // 5. Check for image-objects digest
  const objectsDigest = getDigestByPathAndDigester(filePath, 'image-objects');
  if (objectsDigest?.content && objectsDigest.status === 'completed') {
    try {
      const objectsData = JSON.parse(objectsDigest.content);
      if (objectsData.objects && Array.isArray(objectsData.objects)) {
        // Extract searchable text from objects: title + description
        const objectTexts = objectsData.objects.map((obj: { title?: string; description?: string }) => {
          const parts = [];
          if (obj.title) parts.push(obj.title);
          if (obj.description) parts.push(obj.description);
          return parts.join(': ');
        }).filter(Boolean);
        if (objectTexts.length > 0) {
          contentParts.push(objectTexts.join('\n'));
        }
      }
    } catch (error) {
      log.warn({ filePath, error }, 'failed to parse image-objects digest');
    }
  }

  // 7. Check for speech-recognition digest
  const speechDigest = getDigestByPathAndDigester(filePath, 'speech-recognition');
  if (speechDigest?.content && speechDigest.status === 'completed') {
    try {
      const transcriptData = JSON.parse(speechDigest.content);
      if (transcriptData.segments && Array.isArray(transcriptData.segments)) {
        contentParts.push(transcriptData.segments.map((s: { text: string }) => s.text).join(' '));
      } else {
        contentParts.push(speechDigest.content);
      }
    } catch {
      contentParts.push(speechDigest.content);
    }
  }

  // 8. Read from filesystem for text files
  const fileRecord = getFileByPath(filePath);
  const filename = path.basename(filePath);
  if (isTextFile(fileRecord?.mimeType ?? null, filename)) {
    try {
      const dataDir = process.env.MY_DATA_DIR || './data';
      const fullPath = path.join(dataDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      contentParts.push(content);
    } catch (error) {
      log.warn({ filePath, error }, 'failed to read file from filesystem');
    }
  }

  // 9. For folders, try to read text.md
  if (fileRecord?.isFolder) {
    try {
      const dataDir = process.env.MY_DATA_DIR || './data';
      const textMdPath = path.join(dataDir, filePath, 'text.md');
      const content = await fs.readFile(textMdPath, 'utf-8');
      contentParts.push(content);
    } catch {
      // text.md doesn't exist, that's ok
    }
  }

  return contentParts.length > 0 ? contentParts.join('\n\n') : null;
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
