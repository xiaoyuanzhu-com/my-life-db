import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { generateSlugFromContentDigest } from '@/lib/digest/content-slug';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';
import type { DigestPipelinePayload } from '@/types/digest-workflow';
import { createDigest, getDigestByItemAndType } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxSlug' });

/**
 * Load content from database for slug generation
 * Prefers summary, falls back to content-md
 */
function loadSlugSource(itemId: string): { text: string; source: string } {
  // Try summary first (shorter, more focused)
  const summaryDigest = getDigestByItemAndType(itemId, 'summary');
  if (summaryDigest?.content) {
    return {
      text: summaryDigest.content,
      source: 'summary digest',
    };
  }

  // Fall back to content-md
  const contentDigest = getDigestByItemAndType(itemId, 'content-md');
  if (contentDigest?.content) {
    return {
      text: contentDigest.content,
      source: 'content-md digest',
    };
  }

  throw new Error('No content available for slug generation');
}

function clampText(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function enqueueUrlSlug(itemId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_slug']);

  const taskId = tq('digest_url_slug').add({
    itemId: itemId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  upsertInboxTaskState({
    itemId: itemId,
    taskType: 'digest_url_slug',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  log.info({ itemId, taskId }, 'digest_url_slug task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_slug',
  module: 'InboxSlug',
  handler: async (input: { itemId: string } & DigestPipelinePayload) => {
    const { itemId } = input;

    const item = getInboxItemById(itemId);
    if (!item) {
      log.warn({ itemId }, 'item not found for slug generation');
      return { success: false, reason: 'not_found' };
    }

    // Load content from database
    const { text, source } = loadSlugSource(itemId);
    const clipped = clampText(text);

    const result = generateSlugFromContentDigest(clipped);
    if (!result.slug) {
      const message = 'Slug generation returned empty result';
      log.warn({ itemId }, message);
      throw new Error(message);
    }

    // Save slug to database
    const now = new Date().toISOString();
    const payload = {
      slug: result.slug,
      title: result.title,
      source,
      strategy: result.source,
      generatedAt: now,
    };

    createDigest({
      id: `${itemId}-slug`,
      itemId: itemId,
      digestType: 'slug',
      status: 'completed',
      content: JSON.stringify(payload),
      sqlarName: null,
      createdAt: now,
      updatedAt: now,
    });

    // Update aiSlug field in item (for quick access)
    updateInboxItem(itemId, {
      aiSlug: result.slug,
    });

    log.info({ itemId, slug: result.slug, source }, 'slug generated and saved to database');

    return {
      success: true,
      slug: result.slug,
      title: result.title,
      source,
    };
  },
});
