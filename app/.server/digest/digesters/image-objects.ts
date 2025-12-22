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
        required: ['id', 'title', 'name', 'category', 'description', 'bbox', 'certainty'],
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier within this response (e.g., obj_001)',
          },
          title: {
            type: 'string',
            description: 'Concise, human-readable, unique title; may implicitly express Type',
          },
          name: {
            type: 'string',
            description: 'Stable generic noun (e.g., book, laptop, bottle)',
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
          certainty: {
            type: 'string',
            enum: ['certain', 'likely', 'uncertain'],
            description: 'Confidence level based on visual evidence',
          },
        },
      },
    },
  },
};

export type Certainty = 'certain' | 'likely' | 'uncertain';

export interface DetectedObject {
  id: string;
  title: string;
  name: string;
  category: string;
  description: string;
  bbox: [number, number, number, number];
  certainty: Certainty;
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
