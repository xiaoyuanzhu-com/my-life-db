import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { tq } from '@/lib/task-queue';
import { defineTaskHandler, ensureTaskRuntimeReady } from '@/lib/task-queue/handler-registry';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { generateTagsDigest } from '@/lib/digest/tagging';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';
import type { DigestPipelinePayload, UrlDigestPipelineStage } from '@/types/digest-workflow';
import { enqueueUrlSlug } from './slugUrlInboxItem';

const log = getLogger({ module: 'InboxTagging' });

const TAGS_FILENAME = 'digest/tags.json';
const TAGS_MIME = 'application/json';

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

async function loadTaggingSource(folderPath: string): Promise<{ text: string; source: string } | null> {
  const candidates = [
    'digest/content.md',
    'content.md',
    'digest/main-content.md',
    'main-content.md',
    'text.md',
    'note.md',
    'notes.md',
  ];

  for (const candidate of candidates) {
    const text = await readCandidateFile(folderPath, candidate);
    if (text) {
      return { text, source: candidate };
    }
  }

  return null;
}

function clampText(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function writeTagsFile(folderPath: string, tags: string[]): Promise<{ size: number; hash: string }> {
  const digestDir = path.join(folderPath, 'digest');
  await fs.mkdir(digestDir, { recursive: true });

  const payload = {
    tags,
    generatedAt: new Date().toISOString(),
  };

  const buffer = Buffer.from(JSON.stringify(payload, null, 2));
  const tagsPath = path.join(folderPath, TAGS_FILENAME);
  await fs.writeFile(tagsPath, buffer);

  const hash = createHash('sha256').update(buffer).digest('hex');

  return { size: buffer.length, hash };
}

export function enqueueUrlTagging(inboxId: string, options?: DigestPipelinePayload): string {
  ensureTaskRuntimeReady(['digest_url_tagging']);

  const taskId = tq('digest_url_tagging').add({
    inboxId,
    pipeline: options?.pipeline ?? false,
    remainingStages: options?.remainingStages ?? [],
  });

  upsertInboxTaskState({
    inboxId,
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

    const folderPath = path.join(INBOX_DIR, item.folderName);
    const source = await loadTaggingSource(folderPath);
    if (!source) {
      const message = 'No content available for tagging';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    const clipped = clampText(source.text);
    const result = await generateTagsDigest({ text: clipped });

    if (!result.tags.length) {
      const message = 'Tag generation returned no tags';
      log.warn({ inboxId }, message);
      throw new Error(message);
    }

    const { size, hash } = await writeTagsFile(folderPath, result.tags);

    const updatedFiles = item.files.filter((file) => file.filename !== TAGS_FILENAME);
    updatedFiles.push({
      filename: TAGS_FILENAME,
      size,
      mimeType: TAGS_MIME,
      type: 'text',
      hash,
      enrichment: {
        tags: result.tags,
      },
    });

    updateInboxItem(inboxId, {
      files: updatedFiles,
    });

    log.info({ inboxId, tags: result.tags.length, source: source.source }, 'tags generated');

    if (pipeline && Array.isArray(remainingStages) && remainingStages.length > 0) {
      const [nextStage, ...rest] = remainingStages;
      queueNextStage(inboxId, nextStage, rest);
    }

    return {
      success: true,
      tags: result.tags,
      source: source.source,
      tagsFile: TAGS_FILENAME,
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
