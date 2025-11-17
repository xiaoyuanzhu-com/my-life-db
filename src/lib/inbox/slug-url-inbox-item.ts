import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getFileByPath } from '@/lib/db/files';
import { generateSlugFromContentDigest } from '@/lib/digest/content-slug';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload } from '@/types/digest-workflow';
import { createDigest, generateDigestId, getDigestByPathAndDigester } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxSlug' });

/**
 * Load content from database for slug generation
 * Prefers summary, falls back to content-md
 */
function loadSlugSource(filePath: string): { text: string; source: string } {
  // Try summary first (shorter, more focused)
  const summaryDigest = getDigestByPathAndDigester(filePath, 'summary');
  if (summaryDigest?.content) {
    return {
      text: summaryDigest.content,
      source: 'summary digest',
    };
  }

  // Fall back to content-md
  const contentDigest = getDigestByPathAndDigester(filePath, 'content-md');
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

export function enqueueUrlSlug(filePath: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_slug']);

  const taskId = tq('digest_url_slug').add({
    filePath: filePath,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ filePath, taskId }, 'digest_url_slug task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_slug',
  module: 'InboxSlug',
  handler: async (input: { filePath: string } & DigestPipelinePayload) => {
    const { filePath } = input;

    try {
      const file = getFileByPath(filePath);
      if (!file) {
        log.warn({ filePath }, 'file not found for slug generation');
        return { success: false, reason: 'not_found' };
      }

      // Load content from database
      const { text, source } = loadSlugSource(filePath);
      const clipped = clampText(text);

      const result = generateSlugFromContentDigest(clipped);
      if (!result.slug) {
        const message = 'Slug generation returned empty result';
        log.warn({ filePath }, message);
        throw new Error(message);
      }

      // Create enriched digest
      const now = new Date().toISOString();
      const payload = {
        slug: result.slug,
        title: result.title,
        source,
        strategy: result.source,
        generatedAt: now,
      };

      createDigest({
        id: generateDigestId(filePath, 'slug'),
        filePath,
        digester: 'slug',
        status: 'completed',
        content: JSON.stringify(payload),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });

      log.info({ filePath, slug: result.slug, source }, 'slug generated and saved to database');

      return {
        success: true,
        slug: result.slug,
        title: result.title,
        source,
      };
    } catch (error) {
      // Create failed digest
      const errorMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      createDigest({
        id: generateDigestId(filePath, 'slug'),
        filePath,
        digester: 'slug',
        status: 'failed',
        content: null,
        sqlarName: null,
        error: errorMessage,
        createdAt: now,
        updatedAt: now,
      });
      throw error;
    }
  },
});
