import 'server-only';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  upsertQdrantDocument,
  deleteQdrantDocumentsByFile,
  getQdrantDocumentIdsByFile,
} from '@/lib/db/qdrant-documents';
import { getFileByPath } from '@/lib/db/files';
import { listDigestsForPath, getDigestByPathAndDigester } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'IngestQdrant' });

const DATA_DIR = process.env.MY_DATA_DIR || './data';

export interface QdrantIngestResult {
  filePath: string;
  sources: {
    content?: { chunkCount: number };
    summary?: { chunkCount: number };
    tags?: { chunkCount: number };
  };
  totalChunks: number;
}

export interface ChunkResult {
  chunkIndex: number;
  chunkCount: number;
  chunkText: string;
  spanStart: number;
  spanEnd: number;
  overlapTokens: number;
  wordCount: number;
  tokenCount: number;
}

/**
 * Ingest a file to Qdrant (chunked documents for vector search)
 *
 * This function:
 * 1. Gets file metadata from the files table
 * 2. Chunks main content (from URL digest or filesystem)
 * 3. Chunks summary from digest (if available)
 * 4. Chunks tags from digest (if available)
 * 5. Creates qdrant_documents entries for each chunk
 *
 * Each file+source can generate multiple chunks (800-1000 tokens with overlap)
 */
export async function ingestToQdrant(filePath: string): Promise<QdrantIngestResult> {
  log.debug({ filePath }, 'starting Qdrant ingestion');

  // 1. Get file metadata
  const fileRecord = getFileByPath(filePath);
  if (!fileRecord) {
    throw new Error(`File not found: ${filePath}`);
  }

  const digests = listDigestsForPath(filePath);

  const result: QdrantIngestResult = {
    filePath,
    sources: {},
    totalChunks: 0,
  };

  // 2. Index main content (URL digest or filesystem file)
  const contentText = await getFileContent(filePath, fileRecord.isFolder);
  if (contentText && contentText.trim().length > 0) {
    const chunks = chunkText(contentText, { targetTokens: 900, overlapPercent: 0.15 });

    for (const chunk of chunks) {
      const documentId = `${filePath}:content:${chunk.chunkIndex}`;
      const contentHash = hashString(chunk.chunkText);

      upsertQdrantDocument({
        documentId,
        filePath,
        sourceType: 'content',
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        chunkText: chunk.chunkText,
        spanStart: chunk.spanStart,
        spanEnd: chunk.spanEnd,
        overlapTokens: chunk.overlapTokens,
        wordCount: chunk.wordCount,
        tokenCount: chunk.tokenCount,
        contentHash,
        embeddingVersion: 0,
      });
    }

    result.sources.content = { chunkCount: chunks.length };
    result.totalChunks += chunks.length;

    log.debug(
      { filePath, sourceType: 'content', chunkCount: chunks.length },
      'indexed content chunks'
    );
  }

  // 3. Index summary from digest
  const summaryDigest =
    digests.find(d => d.digester === 'url-crawl-summary' && d.status === 'completed') ||
    digests.find(d => d.digester === 'summarize' && d.status === 'completed');
  if (summaryDigest?.content) {
    // Parse JSON to get summary text
    let summaryText: string;
    try {
      const summaryData = JSON.parse(summaryDigest.content);
      summaryText = summaryData.summary || summaryDigest.content; // Fallback for old format
    } catch {
      // Fallback for old format (plain text)
      summaryText = summaryDigest.content;
    }

    const chunks = chunkText(summaryText, { targetTokens: 900, overlapPercent: 0.15 });

    for (const chunk of chunks) {
      const documentId = `${filePath}:summary:${chunk.chunkIndex}`;
      const contentHash = hashString(chunk.chunkText);

      upsertQdrantDocument({
        documentId,
        filePath,
        sourceType: 'summary',
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        chunkText: chunk.chunkText,
        spanStart: chunk.spanStart,
        spanEnd: chunk.spanEnd,
        overlapTokens: chunk.overlapTokens,
        wordCount: chunk.wordCount,
        tokenCount: chunk.tokenCount,
        contentHash,
        embeddingVersion: 0,
      });
    }

    result.sources.summary = { chunkCount: chunks.length };
    result.totalChunks += chunks.length;

    log.debug(
      { filePath, sourceType: 'summary', chunkCount: chunks.length },
      'indexed summary chunks'
    );
  }

  // 4. Index tags from digest (usually single chunk)
  const tagsDigest = digests.find(d => d.digester === 'tags' && d.status === 'completed');
  if (tagsDigest?.content) {
    try {
      const tagsData = JSON.parse(tagsDigest.content);
      const tags = tagsData.tags || tagsData; // Handle both {tags: [...]} and plain [...]
      const tagText = Array.isArray(tags) ? tags.join(', ') : String(tags);

      if (tagText.trim().length > 0) {
        const chunks = chunkText(tagText, { targetTokens: 900, overlapPercent: 0.15 });

        for (const chunk of chunks) {
          const documentId = `${filePath}:tags:${chunk.chunkIndex}`;
          const contentHash = hashString(chunk.chunkText);

          upsertQdrantDocument({
            documentId,
            filePath,
            sourceType: 'tags',
            chunkIndex: chunk.chunkIndex,
            chunkCount: chunk.chunkCount,
            chunkText: chunk.chunkText,
            spanStart: chunk.spanStart,
            spanEnd: chunk.spanEnd,
            overlapTokens: chunk.overlapTokens,
            wordCount: chunk.wordCount,
            tokenCount: chunk.tokenCount,
            contentHash,
            embeddingVersion: 0,
          });
        }

        result.sources.tags = { chunkCount: chunks.length };
        result.totalChunks += chunks.length;

        log.debug(
          { filePath, sourceType: 'tags', chunkCount: chunks.length },
          'indexed tag chunks'
        );
      }
    } catch (error) {
      log.warn({ filePath, error }, 'failed to parse tags digest');
    }
  }

  log.debug(
    { filePath, totalChunks: result.totalChunks },
    'completed Qdrant ingestion'
  );

  return result;
}

/**
 * Delete all Qdrant chunks for a file
 * This deletes both database records AND vectors from Qdrant collection
 */
export async function deleteFromQdrant(filePath: string): Promise<number> {
  // Get document IDs before deletion
  const documentIds = getQdrantDocumentIdsByFile(filePath);

  // Delete from database
  const deletedCount = deleteQdrantDocumentsByFile(filePath);

  // Enqueue Qdrant deletion task to remove vectors from collection
  if (documentIds.length > 0) {
    const { enqueueQdrantDelete } = await import('./qdrant-tasks');
    enqueueQdrantDelete(documentIds);
    log.debug(
      { filePath, deletedCount, queuedForQdrantDeletion: documentIds.length },
      'deleted Qdrant chunks and queued vector deletion'
    );
  } else {
    log.debug({ filePath, deletedCount }, 'deleted Qdrant chunks (no vectors to delete)');
  }

  return deletedCount;
}

/**
 * Re-index a file (delete + ingest)
 */
export async function reindexQdrant(filePath: string): Promise<QdrantIngestResult> {
  deleteFromQdrant(filePath);
  return await ingestToQdrant(filePath);
}

/**
 * Get file content for indexing
 * Priority: 1) URL digest, 2) Doc-to-markdown digest, 3) Image OCR digest, 4) Filesystem file, 5) Folder text.md
 */
async function getFileContent(filePath: string, isFolder: boolean): Promise<string | null> {
  const dataDir = DATA_DIR;

  // 1. Check for URL content digest (url-crawl-content)
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

  // 4. Try reading from filesystem (markdown or text files)
  if (filePath.endsWith('.md') || filePath.endsWith('.txt')) {
    try {
      const fullPath = path.join(dataDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch (error) {
      log.debug({ filePath, error }, 'failed to read file');
    }
  }

  // 5. Try folder's text.md
  if (isFolder) {
    try {
      const textMdPath = path.join(dataDir, filePath, 'text.md');
      const content = await fs.readFile(textMdPath, 'utf-8');
      return content;
    } catch (error) {
      log.debug({ filePath, error }, 'failed to read text.md from folder');
    }
  }

  return null;
}

/**
 * Chunk text into overlapping segments for vector embeddings
 *
 * Strategy:
 * - Target: 800-1000 tokens per chunk
 * - Overlap: 15% (80-180 tokens) to preserve context at boundaries
 * - Boundaries: Prefer markdown headings, then paragraphs, then sentences
 *
 * @param text - Text to chunk
 * @param options - Chunking options
 * @returns Array of chunks with metadata
 */
function chunkText(
  text: string,
  options: {
    targetTokens?: number;
    overlapPercent?: number;
  } = {}
): ChunkResult[] {
  const targetTokens = options.targetTokens ?? 900;
  const overlapPercent = options.overlapPercent ?? 0.15;
  const overlapTokens = Math.floor(targetTokens * overlapPercent);

  // Simple token estimation: ~4 chars per token (rough approximation)
  const charsPerToken = 4;
  const targetChars = targetTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;

  // If text is short enough for single chunk, return it as-is
  if (text.length <= targetChars) {
    const tokenCount = estimateTokens(text);
    return [
      {
        chunkIndex: 0,
        chunkCount: 1,
        chunkText: text,
        spanStart: 0,
        spanEnd: text.length,
        overlapTokens: 0,
        wordCount: countWords(text),
        tokenCount,
      },
    ];
  }

  // Split into chunks with overlap
  const chunks: ChunkResult[] = [];
  let currentPosition = 0;
  let chunkIndex = 0;

  while (currentPosition < text.length) {
    const isLastChunk = currentPosition + targetChars >= text.length;
    const chunkEnd = isLastChunk
      ? text.length
      : findBoundary(text, currentPosition + targetChars);

    const chunkText = text.slice(currentPosition, chunkEnd);
    const tokenCount = estimateTokens(chunkText);

    chunks.push({
      chunkIndex,
      chunkCount: 0, // Will be set after all chunks are created
      chunkText,
      spanStart: currentPosition,
      spanEnd: chunkEnd,
      overlapTokens: chunkIndex > 0 ? overlapTokens : 0,
      wordCount: countWords(chunkText),
      tokenCount,
    });

    if (isLastChunk) break;

    // Move position forward (accounting for overlap with previous chunk)
    currentPosition = chunkEnd - overlapChars;
    chunkIndex++;
  }

  // Set chunk count on all chunks
  const chunkCount = chunks.length;
  chunks.forEach(chunk => {
    chunk.chunkCount = chunkCount;
  });

  return chunks;
}

/**
 * Find optimal boundary for chunk split
 * Priority: markdown heading > double newline (paragraph) > sentence > any whitespace
 */
function findBoundary(text: string, targetPosition: number): number {
  const searchWindow = 200; // Look 200 chars before/after target
  const start = Math.max(0, targetPosition - searchWindow);
  const end = Math.min(text.length, targetPosition + searchWindow);
  const searchText = text.slice(start, end);

  // 1. Try to find markdown heading
  const headingMatch = searchText.match(/\n#{1,6}\s+/g);
  if (headingMatch) {
    const lastHeading = searchText.lastIndexOf(headingMatch[headingMatch.length - 1]);
    if (lastHeading > searchWindow / 2) {
      return start + lastHeading + 1; // +1 to skip the newline
    }
  }

  // 2. Try to find paragraph break (double newline)
  const paragraphMatch = searchText.match(/\n\n+/g);
  if (paragraphMatch) {
    const lastParagraph = searchText.lastIndexOf(paragraphMatch[paragraphMatch.length - 1]);
    if (lastParagraph > searchWindow / 2) {
      return start + lastParagraph + 2; // +2 to skip both newlines
    }
  }

  // 3. Try to find sentence ending
  const sentenceMatch = searchText.match(/[.!?]\s+/g);
  if (sentenceMatch) {
    const lastSentence = searchText.lastIndexOf(sentenceMatch[sentenceMatch.length - 1]);
    if (lastSentence > searchWindow / 2) {
      return start + lastSentence + 2; // +2 for punctuation + space
    }
  }

  // 4. Fall back to any whitespace
  const whitespaceMatch = searchText.match(/\s+/g);
  if (whitespaceMatch) {
    const lastWhitespace = searchText.lastIndexOf(whitespaceMatch[whitespaceMatch.length - 1]);
    if (lastWhitespace > searchWindow / 2) {
      return start + lastWhitespace + 1;
    }
  }

  // 5. No good boundary found, just split at target
  return targetPosition;
}

/**
 * Count words in text (simple whitespace-based count)
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimate token count (rough approximation: 4 chars per token)
 * This is a simplification - actual tokenization depends on the model
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate SHA256 hash of a string
 */
function hashString(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}
