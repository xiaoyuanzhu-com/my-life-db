import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById } from '@/lib/db/inbox';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, updateDigest, getDigestByItemAndType } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxSummary' });

/**
 * Load content from database for summarization
 * Reads content-md digest created by the crawl step
 */
function loadSummarySource(itemId: string): { text: string; source: string } | null {
  // Read content-md digest from database
  const contentDigest = getDigestByItemAndType(itemId, 'content-md');

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

export function enqueueUrlSummary(itemId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_summary']);
  const taskId = tq('digest_url_summary').add({
    itemId: itemId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  // Create pending digest for status tracking
  const now = new Date().toISOString();
  createDigest({
    id: `${itemId}-summary`,
    itemId: itemId,
    digestType: 'summary',
    status: 'pending',
    content: null,
    sqlarName: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  log.info({ itemId, taskId }, 'digest_url_summary task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_summary',
  module: 'InboxSummary',
  handler: async (input: { itemId: string } & DigestPipelinePayload) => {
    const { itemId, pipeline, remainingStages } = input;

    // Update digest status to in-progress
    const summaryDigest = getDigestByItemAndType(itemId, 'summary');
    if (summaryDigest) {
      updateDigest(summaryDigest.id, { status: 'in-progress', error: null });
    }

    try {
      const item = getInboxItemById(itemId);
      if (!item) {
        log.warn({ itemId }, 'item not found for summary');
        return { success: false, reason: 'not_found' };
      }

      // Load content from database
      const source = loadSummarySource(itemId);
      if (!source) {
        const message = 'No content-md digest found for summary (crawl step may have failed)';
        log.warn({ itemId }, message);
        throw new Error(message);
      }

      const clipped = clampText(source.text);
      let summary: string;

      try {
        const result = await summarizeTextDigest({ text: clipped });
        summary = result.summary.trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ itemId, err: message }, 'summary generation failed');
        throw new Error(message);
      }

      if (!summary) {
        const message = 'Summary generation returned empty result';
        log.warn({ itemId }, message);
        throw new Error(message);
      }

      // Update digest with completed status and content
      if (summaryDigest) {
        updateDigest(summaryDigest.id, {
          status: 'completed',
          content: summary,
          error: null,
        });
      }

      log.info({ itemId, source: source.source }, 'summary generated and saved to database');

      if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
        const [nextStage, ...rest] = remainingStages;
        queueNextStage(itemId, nextStage, rest);
      }

      return {
        success: true,
        source: source.source,
      };
    } catch (error) {
      // Update digest status to failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (summaryDigest) {
        updateDigest(summaryDigest.id, { status: 'failed', error: errorMessage });
      }
      throw error;
    }
  },
});

function queueNextStage(
  itemId: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'tagging':
      enqueueUrlTagging(itemId, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(itemId, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ itemId, stage: nextStage }, 'unknown next stage after summary in url digest pipeline');
  }
}
