import 'server-only';

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { tq } from '@/lib/task-queue';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { summarizeTextDigest } from '@/lib/digest/text-summary';
import { getLogger } from '@/lib/log/logger';
import { upsertInboxTaskState } from '@/lib/db/inboxTaskState';

const log = getLogger({ module: 'InboxSummary' });
const SUMMARY_FILENAME = 'digest/summary.md';
const SUMMARY_MIME = 'text/markdown';

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readCandidateFile(folderPath: string, relativePath: string): Promise<string | null> {
  try {
    const filePath = path.join(folderPath, relativePath);
    const buffer = await fs.readFile(filePath);
    const text = buffer.toString('utf-8');

    if (relativePath.toLowerCase().endsWith('.html')) {
      const stripped = htmlToText(text);
      return stripped.length > 0 ? stripped : null;
    }

    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function loadSummarySource(folderPath: string): Promise<{ text: string; source: string } | null> {
  const candidates = [
    'digest/content.md',
    'digest/main-content.md',
    'digest/content.html',
    'content.md',
    'main-content.md',
    'text.md',
    'note.md',
    'notes.md',
  ];

  for (const candidate of candidates) {
    const content = await readCandidateFile(folderPath, candidate);
    if (content) {
      return { text: content, source: candidate };
    }
  }

  return null;
}

function clampText(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function writeSummaryFile(folderPath: string, summary: string): Promise<{ size: number; hash: string }> {
  const digestDir = path.join(folderPath, 'digest');
  await fs.mkdir(digestDir, { recursive: true });

  const output = summary.endsWith('\n') ? summary : `${summary}\n`;
  const buffer = Buffer.from(output, 'utf-8');
  const summaryPath = path.join(folderPath, 'digest', 'summary.md');
  await fs.writeFile(summaryPath, buffer);

  const hash = createHash('sha256').update(buffer).digest('hex');
  return { size: buffer.length, hash };
}

export function enqueueUrlSummary(inboxId: string): string {
  const taskId = tq('digest_url_summary').add({ inboxId });

  upsertInboxTaskState({
    inboxId,
    taskType: 'digest_url_summary',
    status: 'to-do',
    taskId,
    attempts: 0,
    error: null,
  });

  log.info({ inboxId, taskId }, 'digest_url_summary task enqueued');
  return taskId;
}

export function registerUrlSummaryHandler(): void {
  tq('digest_url_summary').setWorker(async (input: { inboxId: string }) => {
    const { inboxId } = input;

    const item = getInboxItemById(inboxId);
    if (!item) {
      log.warn({ inboxId }, 'inbox item not found for summary');
      return { success: false, reason: 'not_found' };
    }

    const folderPath = path.join(INBOX_DIR, item.folderName);
    const source = await loadSummarySource(folderPath);
    if (!source) {
      const message = 'No digestable text found for summary';
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

    const fileMeta = await writeSummaryFile(folderPath, summary);

    const updatedFiles = item.files
      .filter(file => file.filename !== SUMMARY_FILENAME);

    updatedFiles.push({
      filename: SUMMARY_FILENAME,
      size: fileMeta.size,
      mimeType: SUMMARY_MIME,
      type: 'text',
      hash: fileMeta.hash,
    });

    updateInboxItem(inboxId, {
      files: updatedFiles,
      // leave other fields untouched
    });

    log.info({ inboxId, source: source.source }, 'summary generated');
    return {
      success: true,
      source: source.source,
      summaryFile: SUMMARY_FILENAME,
    };
  });

  log.info({}, 'digest_url_summary handler registered');
}
