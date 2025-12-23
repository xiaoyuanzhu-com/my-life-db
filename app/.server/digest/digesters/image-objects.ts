/**
 * Image Objects Digester
 * Detects objects in images using vision model, returning descriptions, categories, tags, and bounding boxes
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { segmentImageWithHaid, type HaidSamMask } from '~/.server/vendors/haid';
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
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ImageObjectAnnotations',
  type: 'object',
  additionalProperties: false,
  required: ['objects'],
  properties: {
    objects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'category', 'description', 'bbox'],
        properties: {
          title: {
            type: 'string',
            description: 'Concise, human-readable, unique title; may implicitly express Type',
          },
          category: {
            type: 'string',
            description: 'High-level classification (e.g., electronics, book, text)',
          },
          description: {
            type: 'string',
            description: 'Visible attributes and readable text verbatim; no hallucination',
          },
          bbox: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            description: '[x1, y1, x2, y2] normalized to [0,1]',
          },
        },
      },
    },
  },
};

/** RLE (Run-Length Encoding) mask format from SAM */
export interface RleMask {
  size: [number, number]; // [height, width]
  counts: number[];
}

export interface DetectedObject {
  title: string;
  category: string;
  description: string;
  bbox: [number, number, number, number];
  rle: RleMask | null; // Segmentation mask, null if no matching mask found
}

export interface ImageObjectsResult {
  objects: DetectedObject[];
}

/**
 * Calculate IoU (Intersection over Union) between two bounding boxes
 * Both boxes should be in [x1, y1, x2, y2] format (pixel coordinates)
 */
function calculateIoU(
  boxA: [number, number, number, number],
  boxB: [number, number, number, number]
): number {
  const [ax1, ay1, ax2, ay2] = boxA;
  const [bx1, by1, bx2, by2] = boxB;

  // Calculate intersection
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  // No intersection
  if (ix1 >= ix2 || iy1 >= iy2) {
    return 0;
  }

  const intersectionArea = (ix2 - ix1) * (iy2 - iy1);
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  const unionArea = areaA + areaB - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

/**
 * Convert normalized bbox [0,1] to pixel coordinates
 */
function normalizedToPixelBox(
  normalizedBox: [number, number, number, number],
  imageWidth: number,
  imageHeight: number
): [number, number, number, number] {
  return [
    normalizedBox[0] * imageWidth,
    normalizedBox[1] * imageHeight,
    normalizedBox[2] * imageWidth,
    normalizedBox[3] * imageHeight,
  ];
}

/**
 * Match detected objects to SAM masks based on bbox overlap
 * Uses IoU (Intersection over Union) as the matching metric
 * Each mask can only be matched to one object (best match wins)
 * Returns a Map from object index to matched mask
 */
function matchObjectsToMasks(
  bboxes: Array<[number, number, number, number]>, // normalized [0,1]
  masks: HaidSamMask[],
  imageWidth: number,
  imageHeight: number,
  minIoU: number = 0.3 // minimum IoU threshold for a valid match
): Map<number, HaidSamMask> {
  const result = new Map<number, HaidSamMask>();
  const usedMasks = new Set<number>();

  // Calculate IoU for all object-mask pairs
  const scores: Array<{ objectIndex: number; maskIndex: number; iou: number }> = [];

  for (let objIdx = 0; objIdx < bboxes.length; objIdx++) {
    const objPixelBox = normalizedToPixelBox(bboxes[objIdx], imageWidth, imageHeight);

    for (let maskIdx = 0; maskIdx < masks.length; maskIdx++) {
      const mask = masks[maskIdx];
      const maskBox = mask.box as [number, number, number, number];
      const iou = calculateIoU(objPixelBox, maskBox);

      if (iou >= minIoU) {
        scores.push({ objectIndex: objIdx, maskIndex: maskIdx, iou });
      }
    }
  }

  // Sort by IoU descending - best matches first
  scores.sort((a, b) => b.iou - a.iou);

  // Greedy matching: assign best matches first
  const assignedObjects = new Set<number>();

  for (const { objectIndex, maskIndex, iou } of scores) {
    if (assignedObjects.has(objectIndex) || usedMasks.has(maskIndex)) {
      continue;
    }

    result.set(objectIndex, masks[maskIndex]);
    assignedObjects.add(objectIndex);
    usedMasks.add(maskIndex);

    log.debug({ objectIndex, maskIndex, iou }, 'matched object to mask');
  }

  return result;
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

    // System prompt for image object detection
    const systemPrompt = `## SYSTEM PROMPT — Image Object Detection for Search & Indexing

You are a high-precision image annotation system for object search and spatial indexing.

Your task is to identify **all meaningful visible objects** in an image and return structured JSON annotations.

This system supports **fuzzy identification**: objects that are partially visible or unclear should still be included when there is visual evidence, using conservative language and uncertainty markers.

---

### Inclusion rules
- Include:
  - Physical objects, UI elements, signs, labels, and readable text.
  - Objects that are partially occluded, low-resolution, or unclear **if they can be reasonably identified**.
- Exclude:
  - Pure background textures with no standalone identity.
  - Speculation with no visual basis.

---

### Uncertainty handling
- Do NOT hallucinate specific brands, models, or text that are not readable.
- If an object is unclear:
  - Include it with a generic identification.
  - Use conservative language such as "appears to be", "likely", or "possibly".
  - Set the \`certainty\` field appropriately.
- If text is present but unreadable, explicitly say so.

---

### Bounding boxes
- Format: \`[x1, y1, x2, y2]\`
- Coordinates are normalized to \`[0,1]\`
- \`(0,0)\` is top-left; \`(1,1)\` is bottom-right
- Must satisfy: \`x1 < x2\`, \`y1 < y2\`
- Boxes must tightly enclose **only the visible pixels** of the object
- If partially out of frame, box the visible portion only

---

### Object Semantics: Type vs Category (IMPORTANT)

These are **two distinct concepts** and MUST NOT be conflated.

#### Category (mandatory, machine-facing)
- \`category\` is a **stable, high-level classification** used for grouping and filtering.
- Use a small, consistent vocabulary.
- Do NOT over-specify.

Examples: electronics, book, text, furniture, person, food, sign, clothing, container, tool, animal, plant, vehicle, ui_element

#### Type (human-facing, used in title)
- \`Type\` is a **human-readable object label**.
- It appears ONLY in the \`title\`.
- \`Type\` may be **implicit** and does NOT need to be explicitly written if the title already expresses it.

##### When Type is implicit (no prefix)
Use a bare noun title when self-explanatory:
- "MacBook"
- "Lip Balm"
- "Water Bottle"
- "Desk Lamp"

##### When Type must be explicit
Use \`<Type>: <Identifier>\` only when it improves clarity:
- "Book: 爱你就像爱生命"
- "Sign: EXIT"
- "Label: INGREDIENTS"
- "Poster: WWDC 2023"
- "Text: 常识"

##### What NOT to do
- Do NOT mirror \`category\` into the title (e.g., "Electronics: MacBook").
- Do NOT force all titles into \`<Type>: ...\` format.

---

### Title rules
- Titles must be:
  - Concise (2–6 words when possible)
  - Human-readable
  - Search-friendly
  - **Unique within the image**
- If multiple similar objects exist, append numeric suffixes in left-to-right order:
  - "MacBook 1", "MacBook 2"
  - "Book 1", "Book 2"

---

### Naming & descriptions
- \`name\`: stable, generic noun phrase (e.g., "book", "laptop", "bottle").
- \`description\`:
  - Describe visible attributes only.
  - Include readable text verbatim (preserve case and symbols).
  - If unreadable, state that clearly.
- Text handling:
  - If text is likely searchable, also create a separate object with \`category: text\`.

---

### Deduplication
- Each physical object appears exactly once.
- Do NOT merge distinct objects.
- Do NOT duplicate objects across categories.

---

### Output requirements
- Output ONLY valid JSON.
- No markdown, no explanations, no commentary.
- Must conform exactly to the provided JSON schema.`;

    // User prompt
    const userPrompt = `Analyze the image and return JSON annotations for all visible objects.

**Output for each object:**
- id: unique identifier (e.g., obj_001, obj_002)
- title: human-readable label, unique within this image
- name: generic noun (e.g., "laptop", "book")
- category: high-level type (e.g., electronics, book, text, furniture, person)
- description: visible attributes; include readable text verbatim
- bbox: [x1, y1, x2, y2] normalized to [0,1], tight around visible pixels
- certainty: "certain" | "likely" | "uncertain"

**Rules:**
- Include partially visible or unclear objects when there is visual evidence
- Do NOT hallucinate unreadable text, brands, or models
- Bounding boxes must satisfy x1 < x2 and y1 < y2
- Add numeric suffixes for duplicate titles (e.g., "Book 1", "Book 2")

Output ONLY valid JSON matching the schema. No markdown or explanation.`;

    // Call vision model
    const result = await callOpenAICompletion({
      model: 'google/gemini-3-flash-preview',
      systemPrompt,
      prompt: userPrompt,
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

    // Parse the JSON response (without RLE initially)
    let parsedObjects: Array<Omit<DetectedObject, 'rle'>>;
    try {
      const parsed = JSON.parse(result.content);
      parsedObjects = parsed.objects;
    } catch (parseError) {
      log.error({ filePath, content: result.content, error: parseError }, 'failed to parse image objects response');
      throw new Error(`Failed to parse image objects response: ${parseError}`);
    }

    // Call SAM API for segmentation masks
    let indexToMask = new Map<number, HaidSamMask>();
    try {
      log.info({ filePath, objectCount: parsedObjects.length }, 'calling SAM for segmentation masks');

      const samResponse = await segmentImageWithHaid({
        imageBase64: base64Image,
        prompt: 'auto',
        pointsPerSide: 32,
        autoMinAreaRatio: 0.001,
      });

      log.info({
        filePath,
        maskCount: samResponse.masks.length,
        imageSize: `${samResponse.image_width}x${samResponse.image_height}`,
      }, 'SAM segmentation completed');

      // Match objects to masks by index
      indexToMask = matchObjectsToMasks(
        parsedObjects.map(obj => obj.bbox),
        samResponse.masks,
        samResponse.image_width,
        samResponse.image_height,
        0.3 // minimum IoU threshold
      );

      log.info({
        filePath,
        objectCount: parsedObjects.length,
        maskCount: samResponse.masks.length,
        matchedCount: indexToMask.size,
      }, 'matched objects to SAM masks');
    } catch (samError) {
      // Log error but continue without RLE - it's optional
      log.warn({ filePath, error: samError, message: samError instanceof Error ? samError.message : String(samError) }, 'SAM segmentation failed, continuing without RLE masks');
    }

    // Build final result with RLE masks
    const objectsWithRle: DetectedObject[] = parsedObjects.map((obj, index) => {
      const matchedMask = indexToMask.get(index);
      return {
        ...obj,
        rle: matchedMask ? matchedMask.rle : null,
      };
    });

    const finalResult: ImageObjectsResult = { objects: objectsWithRle };
    const now = new Date().toISOString();

    // Store the detected objects as JSON
    return [
      {
        filePath,
        digester: 'image-objects',
        status: 'completed',
        content: JSON.stringify(finalResult, null, 2),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
