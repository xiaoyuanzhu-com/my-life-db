/**
 * Doc To Screenshot Digester
 * Converts document files (PDF, PowerPoint, Word, Excel, EPUB) to screenshot images
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { convertDocToScreenshot } from '@/lib/digest/doc-to-screenshot';
import { sqlarStore } from '@/lib/db/sqlar';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DocToScreenshotDigester' });

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

function hashPath(filePath: string): string {
  return Buffer.from(filePath).toString('base64url').slice(0, 12);
}

/**
 * Doc To Screenshot Digester
 * Converts document files to screenshot images using HAID service
 */
export class DocToScreenshotDigester implements Digester {
  readonly name = 'doc-to-screenshot';
  readonly label = 'Doc to Screenshot';
  readonly description = 'Convert PDF, Word, Excel, PowerPoint, and EPUB documents to screenshot images';

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
    db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    log.debug({ filePath, name: file.name }, 'converting document to screenshot');

    // Convert document to screenshot
    // Let errors propagate - coordinator handles retry logic
    const result = await convertDocToScreenshot({
      filePath,
      filename: file.name,
    });

    const now = new Date().toISOString();
    const pathHash = hashPath(filePath);

    // Store screenshot in SQLAR
    const sqlarName = `${pathHash}/doc-to-screenshot/screenshot.png`;
    await sqlarStore(db, sqlarName, result.screenshot);

    log.debug({ filePath, sqlarName, screenshotSize: result.screenshot.length }, 'stored document screenshot in sqlar');

    return [
      {
        filePath,
        digester: 'doc-to-screenshot',
        status: 'completed',
        content: null,
        sqlarName,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
