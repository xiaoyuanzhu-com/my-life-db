import 'server-only';
// Post-Index Enricher: schedules appropriate enrichment after an inbox item is indexed

import path from 'path';
import { promises as fs } from 'fs';
import { INBOX_DIR } from '@/lib/fs/storage';
import { tq } from '@/lib/task-queue';
import { getInboxItemById } from '@/lib/db/inbox';
import { enqueueUrlEnrichment } from './enrichUrlInboxItem';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'PostIndex' });

export function enqueuePostIndex(inboxId: string): string {
  const taskId = tq('post_index').add({ inboxId });
  log.info({ inboxId, taskId }, 'post_index task enqueued');
  return taskId;
}

export function registerPostIndexHandler(): void {
  tq('post_index').setWorker(async (payload: { inboxId: string }) => {
    const { inboxId } = payload;

    try {
      const item = getInboxItemById(inboxId);
      if (!item) {
        log.warn({ inboxId }, 'inbox item not found in post_index');
        return { success: false, reason: 'not_found' };
      }

      // URL enrichment path: derive URL from url.txt or text.md first line
      if (item.type === 'url') {
        const folder = path.join(INBOX_DIR, item.folderName);
        const urlTxt = path.join(folder, 'url.txt');
        let url: string | null = null;

        try {
          const txt = await fs.readFile(urlTxt, 'utf-8');
          url = (txt || '').trim();
        } catch {
          // Fallback: text.md first non-empty line
          try {
            const textMd = await fs.readFile(path.join(folder, 'text.md'), 'utf-8');
            const firstLine = (textMd.split(/\r?\n/).find(l => l.trim().length > 0) || '').trim();
            if (/^https?:\/\//i.test(firstLine)) {
              url = firstLine;
            }
          } catch {
            // no text.md
          }
        }

        if (url) {
          const taskId = enqueueUrlEnrichment(inboxId, url);
          log.info({ inboxId, url, taskId }, 'url enrichment enqueued');
          return { success: true, queued: 'process_url', taskId };
        } else {
          log.warn({ inboxId }, 'url not found for url-type item');
          return { success: false, reason: 'url_missing' };
        }
      }

      // Other types can be handled here in the future
      log.info({ inboxId, type: item.type }, 'no post-index enrichment for type');
      return { success: true, queued: null };
    } catch (err) {
      log.error({ err, inboxId }, 'post_index worker failed');
      return { success: false, error: String(err) };
    }
  });

  log.info({}, 'post_index handler registered');
}
