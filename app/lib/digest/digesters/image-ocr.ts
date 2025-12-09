/**
 * Image OCR Digester
 * Extracts text from images using HAID OCR service
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type BetterSqlite3 from 'better-sqlite3';
import { imageOcrWithHaid } from '@/lib/vendors/haid';
import { DATA_ROOT } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';
import path from 'path';

const log = getLogger({ module: 'ImageOcrDigester' });

// Supported image MIME types
const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

// File extensions as fallback check
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
]);

/**
 * Image OCR Digester
 * Extracts text from images using HAID OCR service
 */
export class ImageOcrDigester implements Digester {
  readonly name = 'image-ocr';
  readonly label = 'Image OCR';
  readonly description = 'Extract text from images using optical character recognition';

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
    log.debug({ filePath, name: file.name }, 'extracting text from image');

    // Get absolute path to image file
    const absolutePath = path.join(DATA_ROOT, filePath);

    // Extract text using HAID OCR
    // Let errors propagate - coordinator handles retry logic
    const result = await imageOcrWithHaid({
      imagePath: absolutePath,
    });

    const now = new Date().toISOString();

    // Only store the extracted text
    return [
      {
        filePath,
        digester: 'image-ocr',
        status: 'completed',
        content: result.text,
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
