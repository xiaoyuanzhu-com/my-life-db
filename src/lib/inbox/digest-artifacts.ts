import 'server-only';

import fs from 'fs/promises';
import path from 'path';

import { DATA_ROOT } from '@/lib/fs/storage';
import type { InboxDigestScreenshot, InboxDigestSlug } from '@/types';
import { getDigestByPathAndType } from '@/lib/db/digests';
import { getFileByPath } from '@/lib/db/files';

/**
 * Read primary text for a file
 * ALWAYS returns original user input from files (source of truth)
 * NEVER returns digest content - digests are rebuildable
 *
 * For single files: reads the file directly
 * For folders: looks for text files in the folder
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg' or 'inbox/uuid-folder')
 */
export async function readPrimaryText(filePath: string): Promise<string | null> {
  const absolutePath = path.join(DATA_ROOT, filePath);

  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isFile()) {
      // Single file: read directly
      const content = await fs.readFile(absolutePath, 'utf-8');
      return content.trim().length > 0 ? content.trim() : null;
    }
  } catch {
    // Not a file, try as folder below
  }

  // Folder: search for text files
  const candidates = [
    'text.md',
    'note.md',
    'notes.md',
    'content.md',
    'main-content.md',
    'url.txt',
  ];

  async function readFileIfExists(name: string): Promise<string | null> {
    try {
      const candidatePath = path.join(absolutePath, name);
      const content = await fs.readFile(candidatePath, 'utf-8');
      return content.trim().length > 0 ? content.trim() : null;
    } catch {
      return null;
    }
  }

  for (const name of candidates) {
    const content = await readFileIfExists(name);
    if (content) return content;
  }

  return null;
}

/**
 * Read crawled content (markdown) from digest
 * This is the enriched/processed content, NOT the original user input
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function readDigestContent(filePath: string): Promise<string | null> {
  const contentDigest = getDigestByPathAndType(filePath, 'content-md');
  return contentDigest?.content || null;
}

/**
 * Read summary digest from database
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function readDigestSummary(filePath: string): Promise<string | null> {
  const summaryDigest = getDigestByPathAndType(filePath, 'summary');
  return summaryDigest?.content || null;
}

/**
 * Read tags digest from database
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function readDigestTags(filePath: string): Promise<string[] | null> {
  const tagsDigest = getDigestByPathAndType(filePath, 'tags');
  if (!tagsDigest?.content) return null;

  try {
    const parsed = JSON.parse(tagsDigest.content) as { tags?: unknown };
    if (!Array.isArray(parsed.tags)) return null;

    const cleaned = parsed.tags
      .map(tag => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(tag => tag.length > 0);

    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Read screenshot digest from SQLAR
 * Returns metadata for serving via API
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function readDigestScreenshot(filePath: string): Promise<InboxDigestScreenshot | null> {
  const screenshotDigest = getDigestByPathAndType(filePath, 'screenshot');
  if (!screenshotDigest?.sqlarName) return null;

  // Extract extension from sqlarName (e.g., "screenshot.png" -> "png")
  const match = screenshotDigest.sqlarName.match(/\.(\w+)$/);
  const extension = match ? match[1] : 'png';
  const mimeType = extensionToMimeType(extension);

  // Return metadata for API serving
  // The actual image data will be served by the API route using sqlarGet()
  return {
    filename: `screenshot.${extension}`,
    mimeType,
    src: `/api/inbox/sqlar/${screenshotDigest.sqlarName}`,
  };
}

/**
 * Read slug digest from database
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function readDigestSlug(filePath: string): Promise<InboxDigestSlug | null> {
  const slugDigest = getDigestByPathAndType(filePath, 'slug');
  if (!slugDigest?.content) return null;

  try {
    const payload = JSON.parse(slugDigest.content) as {
      slug?: unknown;
      title?: unknown;
      source?: unknown;
      generatedAt?: unknown;
    };

    if (typeof payload.slug !== 'string' || payload.slug.trim().length === 0) {
      return null;
    }

    return {
      slug: payload.slug.trim(),
      title: typeof payload.title === 'string' ? payload.title : undefined,
      source: typeof payload.source === 'string' ? payload.source : undefined,
      generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Helper: Map file extension to MIME type
 */
function extensionToMimeType(extension: string): string {
  const map: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
  };
  return map[extension.toLowerCase()] || 'application/octet-stream';
}
