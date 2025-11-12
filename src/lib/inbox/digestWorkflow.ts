import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';

import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { enqueueUrlEnrichment } from './enrichUrlInboxItem';
import type { UrlDigestPipelineStage } from '@/types/digest-workflow';
import { getLogger } from '@/lib/log/logger';
import { deleteDigestsForItem, createDigest } from '@/lib/db/digests';
import { sqlarDeletePrefix } from '@/lib/db/sqlar';
import { getDatabase } from '@/lib/db/connection';

const log = getLogger({ module: 'UrlDigestWorkflow' });

const PIPELINE_ORDER: UrlDigestPipelineStage[] = ['summary', 'tagging', 'slug'];

// Map of digest types
const DIGEST_TYPES = ['content-md', 'summary', 'tags', 'slug'] as const;

export async function startUrlDigestWorkflow(itemId: string): Promise<{ taskId: string }> {
  const item = getInboxItemById(itemId);
  if (!item) {
    throw new Error('Item not found');
  }

  if (item.type !== 'url') {
    throw new Error('URL digest workflow only supports URL items');
  }

  const url = await resolveUrlForInboxItem(item.folderName);
  if (!url) {
    throw new Error('URL not found for item');
  }

  await clearDigestArtifacts(item.id, item.folderName);

  resetTaskStates(itemId);

  const taskId = enqueueUrlEnrichment(itemId, url, {
    pipeline: true,
    remainingStages: [...PIPELINE_ORDER],
  });

  log.info({ itemId, taskId }, 'url digest workflow started');

  return { taskId };
}

async function clearDigestArtifacts(
  itemId: string,
  folderName: string
): Promise<void> {
  // Clear digests from database (new approach - digests stored in DB/SQLAR)
  const db = getDatabase();
  deleteDigestsForItem(itemId);
  sqlarDeletePrefix(db, `${itemId}/`);

  // Update item status
  updateInboxItem(itemId, {
    status: 'enriching',
    enrichedAt: new Date().toISOString(),
    error: null,
  });

  log.debug({ itemId }, 'cleared digest artifacts from database');
}

function resetTaskStates(itemId: string): void {
  // Note: Individual enqueue functions will create pending digests
  // This function is now a no-op since digest creation happens in enqueue functions
  // Keeping it for backward compatibility
  log.debug({ itemId }, 'resetTaskStates called (no-op - digests created by enqueue functions)');
}

async function resolveUrlForInboxItem(folderName: string): Promise<string | null> {
  // Helper function to extract URL from text content
  function firstUrlFromText(text: string | null): string | null {
    if (!text) return null;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.find(line => /^https?:\/\//i.test(line)) || null;
  }

  // For single-file items, folderName is just the filename (e.g., "text.md")
  // For multi-file items, folderName is the folder name (e.g., "uuid/")
  const itemPath = path.join(INBOX_DIR, folderName);

  // Check if this is a single file or a folder
  let isFile = false;
  try {
    const stats = await fs.stat(itemPath);
    isFile = stats.isFile();
  } catch {
    return null; // Path doesn't exist
  }

  if (isFile) {
    // Single-file item: read the file directly
    try {
      const content = await fs.readFile(itemPath, 'utf-8');
      const url = firstUrlFromText(content);
      if (url) return url;
    } catch {
      // continue
    }
    return null;
  }

  // Multi-file item: search for URL in various files
  const baseDir = itemPath;

  async function readFileIfExists(name: string): Promise<string | null> {
    const candidates = new Set<string>([name]);
    if (!name.includes('/') && !name.startsWith('digest/')) {
      candidates.add(`digest/${name}`);
    }

    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(path.join(baseDir, candidate), 'utf-8');
        if (content.trim().length > 0) {
          return content;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  const urlTxt = await readFileIfExists('url.txt');
  let url = (urlTxt || '').trim();

  if (!url) {
    const textMd = await readFileIfExists('text.md');
    url = firstUrlFromText(textMd) || url;
  }

  if (!url) {
    const contentMd = await readFileIfExists('content.md');
    url = firstUrlFromText(contentMd) || url;
  }

  if (!url) {
    const mainContent = await readFileIfExists('main-content.md');
    url = firstUrlFromText(mainContent) || url;
  }

  return url || null;
}
