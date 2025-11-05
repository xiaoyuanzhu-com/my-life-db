import 'server-only';
// Post-Index Enricher: schedules appropriate enrichment after an inbox item is indexed

import { tq } from '@/lib/task-queue';
import { getInboxItemById } from '@/lib/db/inbox';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'PostIndex' });

export function enqueuePostIndex(inboxId: string): string {
  const taskId = tq('post_index').add({ inboxId });
  log.info({ inboxId, taskId }, 'post_index task enqueued');
  return taskId;
}

export function registerPostIndexHandler(): void {
  tq('post_index').setWorker(async (input: { inboxId: string }) => {
    const { inboxId } = input;

    try {
      const item = getInboxItemById(inboxId);
      if (!item) {
        log.warn({ inboxId }, 'inbox item not found in post_index');
        return { success: false, reason: 'not_found' };
      }

      // URL enrichment path: derive URL from url.txt or text.md first line
      if (item.type === 'url') {
        log.info({ inboxId }, 'post_index manual mode active, skipping auto crawl');
        return { success: true, queued: null, note: 'manual_mode' };
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
