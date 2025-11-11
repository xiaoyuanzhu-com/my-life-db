import 'server-only';

import fs from 'fs/promises';
import path from 'path';

import { INBOX_DIR } from '@/lib/fs/storage';
import type { InboxDigestScreenshot, InboxDigestSlug } from '@/types';
import { getDigestByItemAndType } from '@/lib/db/digests';
import { getInboxItemByFolderName } from '@/lib/db/inbox';

/**
 * Read primary text for an inbox item
 * ALWAYS returns original user input from files (source of truth)
 * NEVER returns digest content - digests are rebuildable
 *
 * For single-file items: reads the file directly
 * For multi-file items: looks for text files in the folder
 */
export async function readInboxPrimaryText(folderName: string): Promise<string | null> {
  // Check if folderName is actually a single file (e.g., "text.md", "uuid.md")
  const itemPath = path.join(INBOX_DIR, folderName);
  try {
    const stats = await fs.stat(itemPath);
    if (stats.isFile()) {
      // Single-file item: read the file directly
      const content = await fs.readFile(itemPath, 'utf-8');
      return content.trim().length > 0 ? content.trim() : null;
    }
  } catch {
    // Not a file, try as folder below
  }

  // Multi-file item: search for text files in the folder
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
      const filePath = path.join(itemPath, name);
      const content = await fs.readFile(filePath, 'utf-8');
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
 */
export async function readInboxDigestContent(folderName: string): Promise<string | null> {
  const item = getInboxItemByFolderName(folderName);
  if (!item) return null;

  const contentDigest = getDigestByItemAndType(item.id, 'content-md');
  return contentDigest?.content || null;
}

/**
 * Read summary digest from database
 */
export async function readInboxDigestSummary(folderName: string): Promise<string | null> {
  const item = getInboxItemByFolderName(folderName);
  if (!item) return null;

  const summaryDigest = getDigestByItemAndType(item.id, 'summary');
  return summaryDigest?.content || null;
}

/**
 * Read tags digest from database
 */
export async function readInboxDigestTags(folderName: string): Promise<string[] | null> {
  const item = getInboxItemByFolderName(folderName);
  if (!item) return null;

  const tagsDigest = getDigestByItemAndType(item.id, 'tags');
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
 */
export async function readInboxDigestScreenshot(folderName: string): Promise<InboxDigestScreenshot | null> {
  const item = getInboxItemByFolderName(folderName);
  if (!item) return null;

  const screenshotDigest = getDigestByItemAndType(item.id, 'screenshot');
  if (!screenshotDigest?.sqlarName) return null;

  // Extract extension from sqlarName (e.g., "{id}/screenshot/screenshot.png" -> "png")
  const match = screenshotDigest.sqlarName.match(/\.(\w+)$/);
  const extension = match ? match[1] : 'png';
  const mimeType = extensionToMimeType(extension);

  // Return metadata for API serving
  // The actual image data will be served by the API route using sqlarGet()
  return {
    filename: `screenshot.${extension}`,
    mimeType,
    src: `/api/inbox/sqlar/${encodeURIComponent(screenshotDigest.sqlarName)}`,
  };
}

/**
 * Read slug digest from database
 */
export async function readInboxDigestSlug(folderName: string): Promise<InboxDigestSlug | null> {
  const item = getInboxItemByFolderName(folderName);
  if (!item) return null;

  const slugDigest = getDigestByItemAndType(item.id, 'slug');
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
