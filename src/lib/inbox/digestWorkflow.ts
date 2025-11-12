import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';

import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { enqueueUrlEnrichment } from './enrichUrlInboxItem';
import type { UrlDigestPipelineStage, MessageType } from '@/types/digest-workflow';
import { getLogger } from '@/lib/log/logger';
import { deleteDigestsForItem } from '@/lib/db/digests';
import { sqlarDeletePrefix } from '@/lib/db/sqlar';
import { getDatabase } from '@/lib/db/connection';

const log = getLogger({ module: 'DigestWorkflow' });

const URL_PIPELINE_ORDER: UrlDigestPipelineStage[] = ['summary', 'tagging', 'slug'];

/**
 * Generic digest workflow - detects type and routes to appropriate workflow
 */
export async function startDigestWorkflow(itemId: string): Promise<{ taskId: string }> {
  const item = getInboxItemById(itemId);
  if (!item) {
    throw new Error('Item not found');
  }

  // Race condition protection: reject if already processing
  if (item.status === 'enriching') {
    throw new Error('Workflow already in progress for this item');
  }

  // Detect type if not already detected
  let detectedType = item.detectedType;
  if (!detectedType) {
    detectedType = await detectItemType(item.id, item.folderName);

    // Update item with detected type
    updateInboxItem(item.id, { detectedType });
    log.info({ itemId: item.id, detectedType }, 'detected item type');
  }

  // Route to appropriate workflow based on type
  switch (detectedType) {
    case 'url':
      return await startUrlDigestWorkflow(item.id, item.folderName);
    default:
      throw new Error(`No digest workflow available for type: ${detectedType}`);
  }
}

/**
 * Detect item type by reading content
 */
async function detectItemType(itemId: string, folderName: string): Promise<MessageType> {
  // Read content from file
  const content = await readItemContent(folderName);
  if (!content) {
    return 'text'; // Default
  }

  // Check for URL pattern (matches frontend)
  const urlPattern = /^(https?:\/\/)/i;
  if (urlPattern.test(content.trim())) {
    return 'url';
  }

  return 'text';
}

/**
 * Read text content from item
 */
async function readItemContent(folderName: string): Promise<string | null> {
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
      return await fs.readFile(itemPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Multi-file item: try reading text.md
  try {
    const textPath = path.join(itemPath, 'text.md');
    return await fs.readFile(textPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * URL-specific digest workflow
 */
async function startUrlDigestWorkflow(itemId: string, folderName: string): Promise<{ taskId: string }> {
  const url = await resolveUrlForInboxItem(folderName);
  if (!url) {
    throw new Error('URL not found for item');
  }

  await clearDigestArtifacts(itemId, folderName);

  const taskId = enqueueUrlEnrichment(itemId, url, {
    pipeline: true,
    remainingStages: [...URL_PIPELINE_ORDER],
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
