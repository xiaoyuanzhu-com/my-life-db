/**
 * Doc To Markdown Digester
 * Converts document files (PDF, PowerPoint, Word, Excel, EPUB) to markdown
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { convertDocToMarkdown } from '@/lib/digest/doc-to-markdown';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DocToMarkdownDigester' });

// Supported document MIME types
const SUPPORTED_MIME_TYPES = new Set([
  // PDF
  'application/pdf',
  // Microsoft Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  // Microsoft PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-powerpoint', // .ppt
  // Microsoft Excel
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  // EPUB
  'application/epub+zip',
]);

// File extensions as fallback check
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.epub',
]);

/**
 * Doc To Markdown Digester
 * Converts document files to markdown using HAID service
 */
export class DocToMarkdownDigester implements Digester {
  readonly name = 'doc-to-markdown';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if file is a folder
    if (file.is_folder) {
      return false;
    }

    // Check MIME type first
    if (file.mime_type && SUPPORTED_MIME_TYPES.has(file.mime_type)) {
      return true;
    }

    // Fallback: check file extension
    const fileName = file.name.toLowerCase();
    for (const ext of SUPPORTED_EXTENSIONS) {
      if (fileName.endsWith(ext)) {
        return true;
      }
    }

    return false;
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    log.debug({ filePath, name: file.name }, 'converting document to markdown');

    try {
      // Convert document to markdown
      const result = await convertDocToMarkdown({
        filePath,
        filename: file.name,
      });

      const now = new Date().toISOString();

      return [
        {
          filePath,
          digester: 'doc-to-markdown',
          status: 'completed',
          content: JSON.stringify({
            markdown: result.markdown,
            model: result.model,
            requestId: result.requestId,
            processingTimeMs: result.processingTimeMs,
          }),
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    } catch (error) {
      log.error({ filePath, error }, 'failed to convert document to markdown');

      const now = new Date().toISOString();
      return [
        {
          filePath,
          digester: 'doc-to-markdown',
          status: 'failed',
          content: null,
          sqlarName: null,
          error: error instanceof Error ? error.message : 'Unknown error',
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }
  }
}
