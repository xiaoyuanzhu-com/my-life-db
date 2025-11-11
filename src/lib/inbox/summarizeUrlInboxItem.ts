import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById } from '@/lib/db/inbox';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, getDigestByItemAndType } from '@/lib/db/digests';
import { generateId } from '@/lib/fs/storage';

const log = getLogger({ module: 'InboxSummary' });

/**
 * Load content from database for summarization
 * Reads content-md digest created by the crawl step
 */
function loadSummarySource(inboxId: string): { text: string; source: string } | null {
  // Read content-md digest from database
  const contentDigest = getDigestByItemAndType(inboxId, 'content-md');

  if (contentDigest?.content) {
    return {
      text: contentDigest.content,
      source: 'content-md digest',
    };
  }

  return null;
}

function clampText(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function enqueueUrlSummary(inboxId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_summary']);
  const taskId = tq('digest_url_summary').add({
    inboxId: inboxId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  upsertInboxTaskState({
    itemId: inboxId,
    taskType: 'digest_url_summary',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  log.info({ inboxId, taskId }, 'digest_url_summary task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_summary',
  module: 'InboxSummary',
  handler: async (input: { inboxId: string } & DigestPipelinePayload) => {
    const { inboxId, pipeline, remainingStages } = input;

    const item = getInboxItemById(inboxId);
    if (!item) {
      log.warn({ inboxId }, 'inbox item not found for summary');
      return { success: false, reason: 'not_found' };
    }

    // Load content from database
    const source = loadSummarySource(inboxId);
    if (!source) {
      const message = 'No content-md digest found for summary (crawl step may have failed)';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    const clipped = clampText(source.text);
    let summary: string;

    try {
      const result = await summarizeTextDigest({ text: clipped });
      summary = result.summary.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ inboxId, err: message }, 'summary generation failed');
      throw new Error(message);
    }

    if (!summary) {
      const message = 'Summary generation returned empty result';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    // Save summary to database
    const now = new Date().toISOString();
    createDigest({
      id: `${inboxId}-summary`,
      itemId: inboxId,
      digestType: 'summary',
      status: 'completed',
      content: summary,
      sqlarName: null,
      createdAt: now,
      updatedAt: now,
    });

    log.info({ inboxId, source: source.source }, 'summary generated and saved to database');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(inboxId, nextStage, rest);
    }

    return {
      success: true,
      source: source.source,
    };
  },
});

function queueNextStage(
  inboxId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'tagging':
      enqueueUrlTagging(inboxId, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(inboxId, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ inboxId, stage: nextStage }, 'unknown next stage after summary in url digest pipeline');
  }
}
