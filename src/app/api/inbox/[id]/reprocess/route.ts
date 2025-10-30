import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getInboxItemById } from '@/lib/db/inbox';
import { enqueueUrlProcessing } from '@/lib/inbox/processUrlInboxItem';
import { getStorageConfig } from '@/lib/config/storage';
import path from 'path';
import { promises as fs } from 'fs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/reprocess?stage=crawl|summary|all
 * For now only supports URL crawl reprocessing (stage=crawl or all) when type='url'.
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
      const urlFile = item.files.find((f) => f.filename === 'url.txt');
      if (!urlFile) {
        return NextResponse.json({ error: 'url.txt not found for URL item' }, { status: 400 });
      }

      const storageConfig = await getStorageConfig();
      const urlPath = path.join(
        storageConfig.dataPath,
        '.app',
        'mylifedb',
        'inbox',
        item.folderName,
        'url.txt'
      );
      const url = (await fs.readFile(urlPath, 'utf-8')).trim();
      const taskId = enqueueUrlProcessing(item.id, url);
      actions.push({ stage: 'crawl', taskId });
    }

    // TODO: add summary/screenshot stages as they are implemented

    if (actions.length === 0) {
      return NextResponse.json({ error: 'No supported reprocess actions for this item/stage' }, { status: 400 });
    }

    return NextResponse.json({ success: true, actions });
  } catch (error) {
    console.error('Error reprocessing inbox item:', error);
    return NextResponse.json({ error: 'Failed to reprocess inbox item' }, { status: 500 });
  }
}

