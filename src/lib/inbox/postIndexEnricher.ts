import 'server-only';
// Post-Index Enricher: schedules appropriate enrichment after an item is indexed

import { tq } from '@/lib/task-queue';
import { getInboxItemById } from '@/lib/db/inbox';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'PostIndex' });

export function enqueuePostIndex(itemId: string): string {
  const taskId = tq('post_index').add({ itemId });
  log.info({ itemId, taskId }, 'post_index task enqueued');
  return taskId;
}

export function registerPostIndexHandler(): void {
  tq('post_index').setWorker(async (input: { itemId: string }) => {
    const { itemId } = input;

    try {
      const item = getInboxItemById(itemId);
      if (!item) {
        log.warn({ itemId }, 'item not found in post_index');
        return { success: false, reason: 'not_found' };
      }

      // URL enrichment path: derive URL from url.txt or text.md first line
      if (item.type === 'url') {
        log.info({ itemId }, 'post_index manual mode active, skipping auto crawl');
        return { success: true, queued: null, note: 'manual_mode' };
      }

      // Other types can be handled here in the future
      log.info({ itemId, type: item.type }, 'no post-index enrichment for type');
      return { success: true, queued: null };
    } catch (err) {
      log.error({ err, itemId }, 'post_index worker failed');
      return { success: false, error: String(err) };
    }
  });

  log.info({}, 'post_index handler registered');
}
