import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { generateSlugFromContentDigest } from '@/lib/digest/content-slug';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';
import type { DigestPipelinePayload } from '@/types/digest-workflow';

const log = getLogger({ module: 'InboxSlug' });

const SLUG_FILENAME = 'digest/slug.json';
const SLUG_MIME = 'application/json';

async function readCandidateFile(folderPath: string, relativePath: string): Promise<string | null> {
  try {
    const filePath = path.join(folderPath, relativePath);
    const buffer = await fs.readFile(filePath);
    const text = buffer.toString('utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function loadSlugSource(folderPath: string): Promise<{ text: string; source: string }> {
  const candidates = [
    'digest/content.md',
    'digest/main-content.md',
    'digest/summary.md',
    'content.md',
    'main-content.md',
    'text.md',
  ];

  for (const candidate of candidates) {
    const text = await readCandidateFile(folderPath, candidate);
    if (text) {
      return { text, source: candidate };
    }
  }

  throw new Error('No content available for slug generation');
}

function clampText(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function writeSlugFile(folderPath: string, payload: Record<string, unknown>): Promise<{ size: number; hash: string }> {
  const digestDir = path.join(folderPath, 'digest');
  await fs.mkdir(digestDir, { recursive: true });

  const buffer = Buffer.from(JSON.stringify(payload, null, 2));
  const slugPath = path.join(folderPath, SLUG_FILENAME);
  await fs.writeFile(slugPath, buffer);

  const hash = createHash('sha256').update(buffer).digest('hex');
  return { size: buffer.length, hash };
}

export function enqueueUrlSlug(inboxId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_slug']);

  const taskId = tq('digest_url_slug').add({
    inboxId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  upsertInboxTaskState({
    inboxId,
    taskType: 'digest_url_slug',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  log.info({ inboxId, taskId }, 'digest_url_slug task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_slug',
  module: 'InboxSlug',
  handler: async (input: { inboxId: string } & DigestPipelinePayload) => {
    const { inboxId } = input;

    const item = getInboxItemById(inboxId);
    if (!item) {
      log.warn({ inboxId }, 'inbox item not found for slug generation');
      return { success: false, reason: 'not_found' };
    }

    const folderPath = path.join(INBOX_DIR, item.folderName);
    const { text, source } = await loadSlugSource(folderPath);
    const clipped = clampText(text);

    const result = generateSlugFromContentDigest(clipped);
    if (!result.slug) {
      const message = 'Slug generation returned empty result';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    const payload = {
      slug: result.slug,
      title: result.title,
      source,
      strategy: result.source,
      generatedAt: new Date().toISOString(),
    };

    const { size, hash } = await writeSlugFile(folderPath, payload);

    const updatedFiles = item.files.filter(file => file.filename !== SLUG_FILENAME);
    updatedFiles.push({
      filename: SLUG_FILENAME,
      size,
      mimeType: SLUG_MIME,
      type: 'text',
      hash,
      enrichment: {
        slug: result.slug,
        title: result.title,
        source,
      },
    });

    updateInboxItem(inboxId, {
      files: updatedFiles,
      aiSlug: result.slug,
    });

    log.info({ inboxId, slug: result.slug, source }, 'slug generated');

    return {
      success: true,
      slug: result.slug,
      title: result.title,
      source,
      slugFile: SLUG_FILENAME,
    };
  },
});
