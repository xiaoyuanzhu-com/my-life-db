/**
 * Image Objects Digester
 * Detects objects in images using vision model, returning descriptions, categories, tags, and bounding boxes
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { DATA_ROOT } from '~/.server/fs/storage';
import { getLogger } from '~/.server/log/logger';
import path from 'path';
import fs from 'fs';

const log = getLogger({ module: 'ImageObjectsDigester' });

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

// JSON Schema for structured output
const IMAGE_OBJECTS_SCHEMA = {
  type: 'object',
  properties: {
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the detected object',
          },
          description: {
            type: 'string',
            description: 'Detailed description of the object, including any visible text',
          },
          category: {
            type: 'string',
            description: 'Category of the object (e.g., person, animal, vehicle, furniture, text, food, electronics)',
          },
          bounding_box: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X coordinate of top-left corner (0-1 normalized)' },
              y: { type: 'number', description: 'Y coordinate of top-left corner (0-1 normalized)' },
              width: { type: 'number', description: 'Width of bounding box (0-1 normalized)' },
              height: { type: 'number', description: 'Height of bounding box (0-1 normalized)' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          confidence: {
            type: 'number',
            description: 'Confidence score for the detection (0-1)',
          },
        },
        required: ['name', 'description', 'category', 'bounding_box'],
        additionalProperties: false,
      },
    },
  },
  required: ['objects'],
  additionalProperties: false,
};

export interface DetectedObject {
  name: string;
  description: string;
  category: string;
  bounding_box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence?: number;
}

export interface ImageObjectsResult {
  objects: DetectedObject[];
}

/**
 * Image Objects Digester
 * Detects objects in images using vision model
 */
export class ImageObjectsDigester implements Digester {
  readonly name = 'image-objects';
  readonly label = 'Image Objects';
  readonly description = 'Detect objects in images with descriptions, categories, tags, and bounding boxes';

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
    log.debug({ filePath, name: file.name }, 'detecting objects in image');

    // Get absolute path to image file
    const absolutePath = path.join(DATA_ROOT, filePath);

    // Read image and convert to base64
    const imageBuffer = fs.readFileSync(absolutePath);
    const base64Image = imageBuffer.toString('base64');

    // Determine media type from MIME type or extension
    let mediaType = file.mime_type || 'image/jpeg';
    if (!file.mime_type) {
      const ext = path.extname(file.name).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
      };
      mediaType = mimeMap[ext] || 'image/jpeg';
    }

    // Call vision model
    const result = await callOpenAICompletion({
      model: 'google/gemini-3-flash-preview',
      systemPrompt: `You are an expert image analysis system. Your task is to detect and describe all visible objects in the image.

For each object:
1. Provide a clear name for the object
2. Write a detailed description including any visible text (signs, labels, text on objects)
3. Assign an appropriate category
4. Estimate the bounding box coordinates (normalized 0-1, where 0,0 is top-left)

Be thorough but focus on meaningful objects. Include text elements as separate objects when they are significant.`,
      prompt: 'Analyze this image and detect all objects. For each object, provide: name, description (include any visible text), category, and bounding box coordinates. Return the results in JSON format.',
      images: [
        {
          type: 'base64',
          data: base64Image,
          mediaType,
        },
      ],
      jsonSchema: IMAGE_OBJECTS_SCHEMA,
      temperature: 0.3,
      maxTokens: 4096,
    });

    // Parse the JSON response
    let parsedResult: ImageObjectsResult;
    try {
      parsedResult = JSON.parse(result.content);
    } catch (parseError) {
      log.error({ filePath, content: result.content, error: parseError }, 'failed to parse image objects response');
      throw new Error(`Failed to parse image objects response: ${parseError}`);
    }

    const now = new Date().toISOString();

    // Store the detected objects as JSON
    return [
      {
        filePath,
        digester: 'image-objects',
        status: 'completed',
        content: JSON.stringify(parsedResult, null, 2),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
