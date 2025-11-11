import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';

import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { enqueueUrlEnrichment } from './enrichUrlInboxItem';
import type { UrlDigestPipelineStage } from '@/types/digest-workflow';
import { setInboxTaskState } from '@/lib/db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';
import type { InboxFile } from '@/types';

const log = getLogger({ module: 'UrlDigestWorkflow' });

const PIPELINE_ORDER: UrlDigestPipelineStage[] = ['summary', 'tagging', 'slug'];
const DIGEST_TASK_TYPES = ['digest_url_crawl', 'digest_url_summary', 'digest_url_tagging', 'digest_url_slug'] as const;

export async function startUrlDigestWorkflow(inboxId: string): Promise<{ taskId: string }> {
  const item = getInboxItemById(inboxId);
  if (!item) {
    throw new Error('Inbox item not found');
  }

  if (item.type !== 'url') {
    throw new Error('URL digest workflow only supports URL inbox items');
  }

  const url = await resolveUrlForInboxItem(item.folderName);
  if (!url) {
    throw new Error('URL not found for inbox item');
  }

  await clearDigestArtifacts(item.id, item.folderName, item.files);

  resetTaskStates(inboxId);

  const taskId = enqueueUrlEnrichment(inboxId, url, {
    pipeline: true,
    remainingStages: [...PIPELINE_ORDER],
  });

  log.info({ inboxId, taskId }, 'url digest workflow started');

  return { taskId };
}

async function clearDigestArtifacts(
  inboxId: string,
  folderName: string,
  files: InboxFile[]
): Promise<void> {
  // Only clear digest directory for multi-file items (folders)
  const itemPath = path.join(INBOX_DIR, folderName);
  try {
    const stats = await fs.stat(itemPath);
    if (stats.isDirectory()) {
      const digestDir = path.join(itemPath, 'digest');
      await fs.rm(digestDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Item doesn't exist, ignore
  }

  const filteredFiles = (files ?? []).filter(file => !file.filename.toLowerCase().startsWith('digest/'));

  updateInboxItem(inboxId, {
    files: filteredFiles,
    status: 'enriching',
    enrichedAt: new Date().toISOString(),
    error: null,
  });
}

function resetTaskStates(inboxId: string): void {
  DIGEST_TASK_TYPES.forEach(taskType => {
    setInboxTaskState({
      itemId: inboxId,
      taskType,
      status: 'to-do',
      taskId: null,
      attempts: 0,
      error: null,
    });
  });
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
