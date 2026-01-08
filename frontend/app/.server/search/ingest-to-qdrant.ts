import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  upsertQdrantDocument,
  deleteQdrantDocumentsByFile,
  getQdrantDocumentIdsByFile,
} from '~/.server/db/qdrant-documents';
import { getFileByPath } from '~/.server/db/files';
import { listDigestsForPath, getDigestByPathAndDigester } from '~/.server/db/digests';
import { getLogger } from '~/.server/log/logger';
import { deleteFromQdrant as deleteQdrantVectors } from './qdrant-indexer';

const log = getLogger({ module: 'IngestQdrant' });

const DATA_DIR = process.env.MY_DATA_DIR || './data';

export interface QdrantIngestResult {
  filePath: string;
  /** Map of source type to chunk count (e.g., 'image-ocr': 2, 'image-captioning': 1) */
  sources: Record<string, number>;
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
 * This function indexes each content source independently:
 * - Each digest type (image-ocr, image-captioning, etc.) gets its own chunks
 * - Summary and tags also indexed separately
 * - File content (for .md/.txt) indexed as 'file' source
 *
 * Each source can generate multiple chunks (800-1000 tokens with overlap)
 */
export async function ingestToQdrant(filePath: string): Promise<QdrantIngestResult> {
  log.debug({ filePath }, 'starting Qdrant ingestion');

  // Get file metadata
  const fileRecord = getFileByPath(filePath);
  if (!fileRecord) {
    throw new Error(`File not found: ${filePath}`);
  }

  const result: QdrantIngestResult = {
    filePath,
    sources: {},
    totalChunks: 0,
  };

  // Helper to index a source
  const indexSource = (sourceType: string, text: string) => {
    if (!text || text.trim().length === 0) return;

    const chunks = chunkText(text, { targetTokens: 900, overlapPercent: 0.15 });

    for (const chunk of chunks) {
      const documentId = `${filePath}:${sourceType}:${chunk.chunkIndex}`;
      const contentHash = hashString(chunk.chunkText);

      upsertQdrantDocument({
        documentId,
        filePath,
        sourceType,
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

    result.sources[sourceType] = chunks.length;
    result.totalChunks += chunks.length;

    log.debug(
      { filePath, sourceType, chunkCount: chunks.length },
      'indexed chunks'
    );
  };

  // Collect all content sources
  const contentSources = await getContentSources(filePath, fileRecord.isFolder);

  // Index each source independently
  for (const { sourceType, text } of contentSources) {
    indexSource(sourceType, text);
  }

  // Index summary (url-crawl-summary or speech-recognition-summary)
  const digests = listDigestsForPath(filePath);
  const urlSummaryDigest = digests.find(d => d.digester === 'url-crawl-summary' && d.status === 'completed');
  const speechSummaryDigest = digests.find(d => d.digester === 'speech-recognition-summary' && d.status === 'completed');
  const summaryDigest = urlSummaryDigest || speechSummaryDigest;

  if (summaryDigest?.content) {
    let summaryText: string;
    try {
      const summaryData = JSON.parse(summaryDigest.content);
      summaryText = summaryData.summary || summaryDigest.content;
    } catch {
      summaryText = summaryDigest.content;
    }
    indexSource('summary', summaryText);
  }

  // Index tags
  const tagsDigest = digests.find(d => d.digester === 'tags' && d.status === 'completed');
  if (tagsDigest?.content) {
    try {
      const tagsData = JSON.parse(tagsDigest.content);
      const tags = tagsData.tags || tagsData;
      const tagText = Array.isArray(tags) ? tags.join(', ') : String(tags);
      indexSource('tags', tagText);
    } catch (error) {
      log.warn({ filePath, error }, 'failed to parse tags digest');
    }
  }

  log.debug(
    { filePath, sources: Object.keys(result.sources), totalChunks: result.totalChunks },
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

  // Delete vectors from Qdrant collection (fire-and-forget)
  if (documentIds.length > 0) {
    deleteQdrantVectors(documentIds).catch((err: unknown) => {
      log.error({ err, filePath, count: documentIds.length }, 'Qdrant vector deletion failed');
    });
    log.debug(
      { filePath, deletedCount, triggeredQdrantDeletion: documentIds.length },
      'deleted Qdrant chunks and triggered vector deletion'
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

interface ContentSource {
  sourceType: string;
  text: string;
}

/**
 * Get all content sources for indexing
 *
 * Returns each source separately (not combined) for independent indexing:
 * - URL: url-crawl-content digest
 * - Doc: doc-to-markdown digest
 * - Image: image-ocr, image-captioning, image-objects (each separate)
 * - Speech: speech-recognition digest
 * - Text files: Read from filesystem
 *
 * @returns Array of content sources with their text
 */
async function getContentSources(filePath: string, isFolder: boolean): Promise<ContentSource[]> {
  const dataDir = DATA_DIR;
  const sources: ContentSource[] = [];

  // 1. Check for URL content digest (url-crawl-content)
  const contentDigest = getDigestByPathAndDigester(filePath, 'url-crawl-content');
  if (contentDigest?.content && contentDigest.status === 'completed') {
    let text: string;
    try {
      const contentData = JSON.parse(contentDigest.content);
      text = contentData.markdown || contentDigest.content;
    } catch {
      text = contentDigest.content;
    }
    sources.push({ sourceType: 'url-crawl-content', text });
  }

  // 2. Check for doc-to-markdown digest
  const docDigest = getDigestByPathAndDigester(filePath, 'doc-to-markdown');
  if (docDigest?.content && docDigest.status === 'completed') {
    sources.push({ sourceType: 'doc-to-markdown', text: docDigest.content });
  }

  // 3. Check for image-ocr digest
  const ocrDigest = getDigestByPathAndDigester(filePath, 'image-ocr');
  if (ocrDigest?.content && ocrDigest.status === 'completed') {
    sources.push({ sourceType: 'image-ocr', text: ocrDigest.content });
  }

  // 4. Check for image-captioning digest
  const captionDigest = getDigestByPathAndDigester(filePath, 'image-captioning');
  if (captionDigest?.content && captionDigest.status === 'completed') {
    sources.push({ sourceType: 'image-captioning', text: captionDigest.content });
  }

  // 5. Check for image-objects digest
  const objectsDigest = getDigestByPathAndDigester(filePath, 'image-objects');
  if (objectsDigest?.content && objectsDigest.status === 'completed') {
    try {
      const objectsData = JSON.parse(objectsDigest.content);
      if (objectsData.objects && Array.isArray(objectsData.objects)) {
        const objectTexts = objectsData.objects.map((obj: { title?: string; description?: string }) => {
          const parts = [];
          if (obj.title) parts.push(obj.title);
          if (obj.description) parts.push(obj.description);
          return parts.join(': ');
        }).filter(Boolean);
        if (objectTexts.length > 0) {
          sources.push({ sourceType: 'image-objects', text: objectTexts.join('\n') });
        }
      }
    } catch (error) {
      log.warn({ filePath, error }, 'failed to parse image-objects digest');
    }
  }

  // 6. Check for speech-recognition digest
  const speechDigest = getDigestByPathAndDigester(filePath, 'speech-recognition');
  if (speechDigest?.content && speechDigest.status === 'completed') {
    let text: string;
    try {
      const transcriptData = JSON.parse(speechDigest.content);
      if (transcriptData.segments && Array.isArray(transcriptData.segments)) {
        text = transcriptData.segments.map((s: { text: string }) => s.text).join(' ');
      } else {
        text = speechDigest.content;
      }
    } catch {
      text = speechDigest.content;
    }
    sources.push({ sourceType: 'speech-recognition', text });
  }

  // 7. Try reading from filesystem (markdown or text files)
  if (filePath.endsWith('.md') || filePath.endsWith('.txt')) {
    try {
      const fullPath = path.join(dataDir, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      sources.push({ sourceType: 'file', text: content });
    } catch (error) {
      log.debug({ filePath, error }, 'failed to read file');
    }
  }

  // 8. Try folder's text.md
  if (isFolder) {
    try {
      const textMdPath = path.join(dataDir, filePath, 'text.md');
      const content = await fs.readFile(textMdPath, 'utf-8');
      sources.push({ sourceType: 'file', text: content });
    } catch (error) {
      log.debug({ filePath, error }, 'failed to read text.md from folder');
    }
  }

  return sources;
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
