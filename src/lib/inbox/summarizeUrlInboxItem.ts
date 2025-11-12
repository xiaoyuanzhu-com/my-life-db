import 'server-only';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getFileByPath } from '@/lib/db/files';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { getLogger } from '@/lib/log/logger';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlTagging } from './tagUrlInboxItem';
import { enqueueUrlSlug } from './slugUrlInboxItem';
import { createDigest, generateDigestId, getDigestByPathAndType } from '@/lib/db/digests';

const log = getLogger({ module: 'InboxSummary' });

/**
 * Load content from database for summarization
 * Reads content-md digest created by the crawl step
 */
function loadSummarySource(filePath: string): { text: string; source: string } | null {
  // Read content-md digest from database
  const contentDigest = getDigestByPathAndType(filePath, 'content-md');

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

export function enqueueUrlSummary(filePath: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_summary']);
  const taskId = tq('digest_url_summary').add({
    filePath: filePath,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  log.info({ filePath, taskId }, 'digest_url_summary task enqueued');
  return taskId;
}

defineTaskHandler({
  type: 'digest_url_summary',
  module: 'InboxSummary',
  handler: async (input: { filePath: string } & DigestPipelinePayload) => {
    const { filePath, pipeline, remainingStages } = input;

    try {
      const file = getFileByPath(filePath);
      if (!file) {
        log.warn({ filePath }, 'file not found for summary');
        return { success: false, reason: 'not_found' };
      }

      // Load content from database
      const source = loadSummarySource(filePath);
      if (!source) {
        const message = 'No content-md digest found for summary (crawl step may have failed)';
        log.warn({ filePath }, message);
        throw new Error(message);
      }

      const clipped = clampText(source.text);
      let summary: string;

      try {
        const result = await summarizeTextDigest({ text: clipped });
        summary = result.summary.trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ filePath, err: message }, 'summary generation failed');
        throw new Error(message);
      }

      if (!summary) {
        const message = 'Summary generation returned empty result';
        log.warn({ filePath }, message);
        throw new Error(message);
      }

      // Create enriched digest
      const now = new Date().toISOString();
      createDigest({
        id: generateDigestId(filePath, 'summary'),
        filePath,
        digestType: 'summary',
        status: 'enriched',
        content: summary,
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });

      log.info({ filePath, source: source.source }, 'summary generated and saved to database');

      if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
        const [nextStage, ...rest] = remainingStages;
        queueNextStage(filePath, nextStage, rest);
      }

      return {
        success: true,
        source: source.source,
      };
    } catch (error) {
      // Create failed digest
      const errorMessage = error instanceof Error ? error.message : String(error);
      const now = new Date().toISOString();
      createDigest({
        id: generateDigestId(filePath, 'summary'),
        filePath,
        digestType: 'summary',
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
  filePath: string,
  nextStage: UrlDigestPipelineStage,
  remaining: UrlDigestPipelineStage[]
): void {
  switch (nextStage) {
    case 'tagging':
      enqueueUrlTagging(filePath, { pipeline: true, remainingStages: remaining });
      break;
    case 'slug':
      enqueueUrlSlug(filePath, { pipeline: true, remainingStages: remaining });
      break;
    default:
      log.warn({ filePath, stage: nextStage }, 'unknown next stage after summary in url digest pipeline');
  }
}
