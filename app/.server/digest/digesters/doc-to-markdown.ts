/**
 * Doc To Markdown Digester
 * Converts document files (PDF, PowerPoint, Word, Excel, EPUB) to markdown
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { convertDocToMarkdown } from '~/.server/digest/doc-to-markdown';
import { getLogger } from '~/.server/log/logger';

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
  readonly label = 'Doc to Markdown';
  readonly description = 'Convert PDF, Word, Excel, PowerPoint, and EPUB documents to markdown';

  async canDigest(
    _filePath: string,
    file: FileRecordRow,
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
  ): Promise<DigestInput[]> {
    log.debug({ filePath, name: file.name }, 'converting document to markdown');

    // Convert document to markdown
    // Let errors propagate - coordinator handles retry logic
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
        content: result.markdown,
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
