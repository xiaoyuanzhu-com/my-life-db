import 'server-only';
/**
 * Task for running URL crawl digest via task queue.
 */

import { tq } from '@/lib/task-queue';
import { crawlUrlDigest } from './url-crawl';

export type UrlCrawlTaskInput = { url: string; timeoutMs?: number };

export function enqueueUrlCrawl(url: string, timeoutMs?: number): string {
  return tq('digest_url_crawl').add({ url, timeoutMs });
}

export function registerUrlCrawlHandler(): void {
  tq('digest_url_crawl').setWorker(async (input: UrlCrawlTaskInput) => {
    return await crawlUrlDigest(input);
  });
}

