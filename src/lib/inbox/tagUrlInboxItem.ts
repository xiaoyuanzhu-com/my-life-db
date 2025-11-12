import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById } from '@/lib/db/inbox';
import { generateTagsDigest } from '@/lib/digest/tagging';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, getDigestByItemAndType } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxTagging' });

/**
 * Load content from database for tagging
 */
function loadTaggingSource(itemId: string): { text: string; source: string } | null {
  const contentDigest = getDigestByItemAndType(itemId, 'content-md');

  if (contentDigest?.content) {
    return {
      text: contentDigest.content,
      source: 'content-md digest',
    };
  }

  return null;
}

function clampText(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function enqueueUrlTagging(itemId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_tagging']);

  const taskId = tq('digest_url_tagging').add({
    itemId: itemId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ itemId, taskId }, 'digest_url_tagging task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_tagging',
  module: 'InboxTagging',
  handler: async (input: { itemId: string } & DigestPipelinePayload) => {
    const { itemId, pipeline, remainingStages } = input;

    try {
      const item = getInboxItemById(itemId);
      if (!item) {
        log.warn({ itemId }, 'item not found for tagging');
        return { success: false, reason: 'not_found' };
      }

      // Load content from database
      const source = loadTaggingSource(itemId);
      if (!source) {
        const message = 'No content-md digest found for tagging';
        log.warn({ itemId }, message);
        throw new Error(message);
      }

      const clipped = clampText(source.text);
      const result = await generateTagsDigest({ text: clipped });

      if (!result.tags.length) {
        const message = 'Tag generation returned no tags';
        log.warn({
          itemId: itemId,
          sourceTextLength: source.text.length,
          clippedTextLength: clipped.length,
          clippedTextPreview: clipped.substring(0, 200),
          resultTags: result.tags,
        }, message);
        throw new Error(message);
      }

      // Create completed digest
      const now = new Date().toISOString();
      const tagsPayload = {
        tags: result.tags,
        generatedAt: now,
      };

      createDigest({
        id: `${itemId}-tags`,
        itemId,
        digestType: 'tags',
        status: 'completed',
        content: JSON.stringify(tagsPayload),
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });

      log.info({ itemId, tags: result.tags.length, source: source.source }, 'tags generated and saved to database');

      if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
        const [nextStage, ...rest] = remainingStages;
        queueNextStage(itemId, nextStage, rest);
      }

      return {
        success: true,
        tags: result.tags,
        source: source.source,
      };
    } catch (error) {
      // Create failed digest
      const errorMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      createDigest({
        id: `${itemId}-tags`,
        itemId,
        digestType: 'tags',
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

function queueNextStage(
  itemId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  if (nextStage === 'slug') {
    enqueueUrlSlug(itemId, { pipeline: true, remainingStages: remaining });
  } else {
    log.warn({ itemId, stage: nextStage }, 'unknown next stage after tagging in url digest pipeline');
  }
}
