import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { generateSlugFromContentDigest } from '@/lib/digest/content-slug';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload } from '@/types/digest-workflow';
import { createDigest, updateDigest, getDigestByItemAndType } from '@/lib/db/digests';

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

  // Create pending digest for status tracking
  const now = new Date().toISOString();
  createDigest({
    id: `${itemId}-slug`,
    itemId: itemId,
    digestType: 'slug',
    status: 'pending',
    content: null,
    sqlarName: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  log.info({ itemId, taskId }, 'digest_url_slug task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_slug',
  module: 'InboxSlug',
  handler: async (input: { itemId: string } & DigestPipelinePayload) => {
    const { itemId } = input;

    // Update digest status to in-progress
    const slugDigest = getDigestByItemAndType(itemId, 'slug');
    if (slugDigest) {
      updateDigest(slugDigest.id, { status: 'in-progress', error: null });
    }

    try {
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

      // Update digest with completed status and content
      const payload = {
        slug: result.slug,
        title: result.title,
        source,
        strategy: result.source,
        generatedAt: new Date().toISOString(),
      };

      if (slugDigest) {
        updateDigest(slugDigest.id, {
          status: 'completed',
          content: JSON.stringify(payload),
          error: null,
        });
      }

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
    } catch (error) {
      // Update digest status to failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (slugDigest) {
        updateDigest(slugDigest.id, { status: 'failed', error: errorMessage });
      }
      throw error;
    }
  },
});
