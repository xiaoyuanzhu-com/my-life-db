import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById } from '@/lib/db/inbox';
import { generateTagsDigest } from '@/lib/digest/tagging';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, getDigestByItemAndType } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxTagging' });

/**
 * Load content from database for tagging
 */
function loadTaggingSource(inboxId: string): { text: string; source: string } | null {
  const contentDigest = getDigestByItemAndType(inboxId, 'content-md');

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

export function enqueueUrlTagging(inboxId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_tagging']);

  const taskId = tq('digest_url_tagging').add({
    itemId: inboxId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  upsertInboxTaskState({
    itemId: inboxId,
    taskType: 'digest_url_tagging',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  log.info({ inboxId, taskId }, 'digest_url_tagging task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_tagging',
  module: 'InboxTagging',
  handler: async (input: { inboxId: string } & DigestPipelinePayload) => {
    const { inboxId, pipeline, remainingStages } = input;

    const item = getInboxItemById(inboxId);
    if (!item) {
      log.warn({ inboxId }, 'inbox item not found for tagging');
      return { success: false, reason: 'not_found' };
    }

    // Load content from database
    const source = loadTaggingSource(inboxId);
    if (!source) {
      const message = 'No content-md digest found for tagging';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    const clipped = clampText(source.text);
    const result = await generateTagsDigest({ text: clipped });

    if (!result.tags.length) {
      const message = 'Tag generation returned no tags';
      log.warn({
        itemId: inboxId,
        sourceTextLength: source.text.length,
        clippedTextLength: clipped.length,
        clippedTextPreview: clipped.substring(0, 200),
        resultTags: result.tags,
      }, message);
      throw new Error(message);
    }

    // Save tags to database
    const now = new Date().toISOString();
    const tagsPayload = {
      tags: result.tags,
      generatedAt: now,
    };

    createDigest({
      id: `${inboxId}-tags`,
      itemId: inboxId,
      digestType: 'tags',
      status: 'completed',
      content: JSON.stringify(tagsPayload),
      sqlarName: null,
      createdAt: now,
      updatedAt: now,
    });

    log.info({ inboxId, tags: result.tags.length, source: source.source }, 'tags generated and saved to database');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(inboxId, nextStage, rest);
    }

    return {
      success: true,
      tags: result.tags,
      source: source.source,
    };
  },
});

function queueNextStage(
  inboxId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  if (nextStage === 'slug') {
    enqueueUrlSlug(inboxId, { pipeline: true, remainingStages: remaining });
  } else {
    log.warn({ inboxId, stage: nextStage }, 'unknown next stage after tagging in url digest pipeline');
  }
}
