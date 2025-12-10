/**
 * Image Captioning Digester
 * Generates captions for images using HAID image captioning service
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { imageCaptioningWithHaid } from '~/lib/vendors/haid';
import { DATA_ROOT } from '~/lib/fs/storage';
import { getLogger } from '~/lib/log/logger';
import path from 'path';

const log = getLogger({ module: 'ImageCaptioningDigester' });

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
 * Image Captioning Digester
 * Generates captions for images using HAID image captioning service
 */
export class ImageCaptioningDigester implements Digester {
  readonly name = 'image-captioning';
  readonly label = 'Image Captioning';
  readonly description = 'Generate descriptive captions for images using AI';

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
    log.debug({ filePath, name: file.name }, 'generating caption for image');

    // Get absolute path to image file
    const absolutePath = path.join(DATA_ROOT, filePath);

    // Generate caption using HAID
    // Let errors propagate - coordinator handles retry logic
    const result = await imageCaptioningWithHaid({
      imagePath: absolutePath,
    });

    const now = new Date().toISOString();

    // Store the generated caption
    return [
      {
        filePath,
        digester: 'image-captioning',
        status: 'completed',
        content: result.caption,
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
