import 'server-only';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { chunkMarkdownContent } from './chunker';
import { listDocumentIds, replaceSearchDocuments } from './search-documents';
import type { ContentType, SearchDocumentInsert, SearchDocumentMetadata, SearchVariant } from './types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SearchIngest' });

export interface UrlContentIngestOptions {
  entryId: string;
  libraryId?: string | null;
  markdownPath: string;
  sourcePath: string;
  sourceUrl?: string | null;
  contentType?: ContentType;
  variant?: SearchVariant;
  metadata?: SearchDocumentMetadata;
}

export interface UrlContentIngestResult {
  documentIds: string[];
  staleDocumentIds: string[];
  chunkCount: number;
}

export async function ingestMarkdownForSearch(
  options: UrlContentIngestOptions
): Promise<UrlContentIngestResult> {
  const contentType: ContentType = options.contentType ?? 'url';
  const variant: SearchVariant = options.variant ?? 'content';
  const normalizedMetadata = options.metadata ?? {};

  try {
    const markdown = await fs.readFile(options.markdownPath, 'utf-8');
    const chunks = chunkMarkdownContent(markdown);
    if (chunks.length === 0) {
      log.warn(
        {
          entryId: options.entryId,
          variant,
          markdownPath: options.markdownPath,
        },
        'no chunks generated for search ingestion'
      );
      return { documentIds: [], staleDocumentIds: [], chunkCount: 0 };
    }

    const previousIds = listDocumentIds(options.entryId, variant);
    const metadataHash = hashString(JSON.stringify(normalizedMetadata));

    const documents: SearchDocumentInsert[] = chunks.map(chunk => {
      const docId = buildDocumentId(options.entryId, variant, chunk.chunkIndex);
      const contentHash = hashString(`${chunk.text}::${metadataHash}`);
      return {
        documentId: docId,
        entryId: options.entryId,
        libraryId: options.libraryId ?? null,
        contentType,
        sourceUrl: options.sourceUrl ?? null,
        sourcePath: normalizeSourcePath(options.sourcePath),
        variant,
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        spanStart: chunk.spanStart,
        spanEnd: chunk.spanEnd,
        overlapTokens: chunk.overlapTokens,
        wordCount: chunk.wordCount,
        tokenCount: chunk.tokenCount,
        contentHash,
        chunkText: chunk.text,
        metadata: normalizedMetadata,
      };
    });

    replaceSearchDocuments({
      entryId: options.entryId,
      variant,
      documents,
    });

    const insertedIds = documents.map(doc => doc.documentId);
    const staleIds = previousIds.filter(id => !insertedIds.includes(id));

    log.info(
      {
        entryId: options.entryId,
        variant,
        chunkCount: documents.length,
        staleCount: staleIds.length,
      },
      'ingested search documents for markdown content'
    );

    return {
      documentIds: insertedIds,
      staleDocumentIds: staleIds,
      chunkCount: documents.length,
    };
  } catch (error) {
    log.error(
      {
        err: error,
        entryId: options.entryId,
        variant,
        markdownPath: options.markdownPath,
      },
      'failed to ingest markdown for search'
    );
    return { documentIds: [], staleDocumentIds: [], chunkCount: 0 };
  }
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildDocumentId(entryId: string, variant: string, chunkIndex: number): string {
  return `${entryId}:${variant}:${chunkIndex}`;
}

function normalizeSourcePath(sourcePath: string): string {
  if (!sourcePath) return '';
  return sourcePath.replace(/\\/g, '/');
}
