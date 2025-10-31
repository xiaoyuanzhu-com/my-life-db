import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getInboxItemById } from '@/lib/db/inbox';
import { enqueueUrlEnrichment } from '@/lib/inbox/enrichUrlInboxItem';
import { getStorageConfig } from '@/lib/config/storage';
import path from 'path';
import { promises as fs } from 'fs';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxReenrich' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/reenrich?stage=crawl|summary|all
 * For now only supports URL crawl re-enrichment (stage=crawl or all) when type='url'.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const searchParams = request.nextUrl.searchParams;
    const stage = (searchParams.get('stage') || 'all').toLowerCase();

    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const actions: Array<{ stage: string; taskId: string | null; note?: string }> = [];

    if ((stage === 'crawl' || stage === 'all') && item.type === 'url') {
      const storageConfig = await getStorageConfig();
      const baseDir = path.join(
        storageConfig.dataPath,
        '.app',
        'mylifedb',
        'inbox',
        item.folderName,
      );

      async function readFileIfExists(name: string): Promise<string | null> {
        try {
          const p = path.join(baseDir, name);
          const s = await fs.readFile(p, 'utf-8');
          return s;
        } catch {
          return null;
        }
      }

      function firstUrlFromText(text: string | null): string | null {
        if (!text) return null;
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const urlLike = lines.find((l) => /^https?:\/\//i.test(l));
        return urlLike || null;
      }

      // Try url.txt, then fall back to first URL-like line in text files
      const urlTxt = await readFileIfExists('url.txt');
      let url = (urlTxt || '').trim();
      if (!url) {
        const textMd = await readFileIfExists('text.md');
        url = firstUrlFromText(textMd) || '';
      }
      if (!url) {
        const contentMd = await readFileIfExists('content.md');
        url = firstUrlFromText(contentMd) || '';
      }
      if (!url) {
        const mainContent = await readFileIfExists('main-content.md');
        url = firstUrlFromText(mainContent) || '';
      }

      if (!url) {
        log.warn({ id: item.id, folderName: item.folderName }, 'url not found for url-type item');
        return NextResponse.json({ error: 'url not found for URL item' }, { status: 400 });
      }

      const taskId = enqueueUrlEnrichment(item.id, url);
      actions.push({ stage: 'crawl', taskId });
    }

    // TODO: add summary/screenshot stages as they are implemented

    if (actions.length === 0) {
      return NextResponse.json({ error: 'No supported reenrich actions for this item/stage' }, { status: 400 });
    }

    return NextResponse.json({ success: true, actions });
  } catch (error) {
    log.error({ err: error }, 'reenrich inbox item failed');
    return NextResponse.json({ error: 'Failed to reenrich inbox item' }, { status: 500 });
  }
}
