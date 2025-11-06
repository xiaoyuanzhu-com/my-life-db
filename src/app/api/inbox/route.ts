// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
// import { promises as fs } from 'fs';
// import path from 'path';
import { createInboxEntry } from '@/lib/inbox/createInboxEntry';
import { listInboxItems } from '@/lib/db/inbox';
import { getInboxTaskStatesForInboxIds } from '@/lib/db/inboxTaskState';
import { summarizeInboxEnrichment } from '@/lib/inbox/statusView';
// import { enqueueUrlEnrichment } from '@/lib/inbox/enrichUrlInboxItem';
// import { getStorageConfig } from '@/lib/config/storage';
import { getLogger } from '@/lib/log/logger';
import { readInboxPrimaryText, readInboxDigestScreenshot } from '@/lib/inbox/digestArtifacts';

// Force Node.js runtime (not Edge)
export const runtime = 'nodejs';

// Note: App initialization now happens in instrumentation.ts at server startup

/**
 * GET /api/inbox
 * List inbox items
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') || undefined;
    const limit = searchParams.get('limit')
      ? parseInt(searchParams.get('limit')!)
      : 50;
    const offset = searchParams.get('offset')
      ? parseInt(searchParams.get('offset')!)
      : 0;

    const items = listInboxItems({ status, limit, offset });

    // Include enrichment summaries for all items (batch query)
    const ids = items.map((i) => i.id);
    const statesByInbox = getInboxTaskStatesForInboxIds(ids);

    const itemsWithEnrichment = await Promise.all(
      items.map(async (item) => {
        const states = statesByInbox[item.id] || [];
        const enrichment = summarizeInboxEnrichment(item, states);
        const [primaryText, screenshot] = await Promise.all([
          readInboxPrimaryText(item.folderName),
          enrichment.screenshotReady ? readInboxDigestScreenshot(item.folderName) : Promise.resolve(null),
        ]);
        return {
          ...item,
          enrichment,
          primaryText,
          digestScreenshot: screenshot,
        };
      })
    );

    return NextResponse.json({
      items: itemsWithEnrichment,
      total: items.length,
    });
  } catch (error) {
    log.error({ err: error }, 'list inbox items failed');
    return NextResponse.json(
      { error: 'Failed to list inbox items' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/inbox
 * Create a new inbox item
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const text = formData.get('text') as string | null;
    const fileEntries = formData.getAll('files') as File[];

    // Validation
    if (!text && fileEntries.length === 0) {
      return NextResponse.json(
        { error: 'Either text or files must be provided' },
        { status: 400 }
      );
    }

    // Process uploaded files
    const files = [];
    for (const file of fileEntries) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      files.push({
        buffer,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });
    }

    // Create inbox entry
    const inboxItem = await createInboxEntry({
      text: text || undefined,
      files,
    });

    // TEMP: disable auto enqueue of URL enrichment
    // if (inboxItem.type === 'url') {
    //   const urlFile = inboxItem.files.find(f => f.filename === 'url.txt');
    //   if (urlFile) {
    //     try {
    //       // Read URL from file and enqueue processing
    //       const storageConfig = await getStorageConfig();
    //       const urlPath = path.join(
    //         storageConfig.dataPath,
    //         '.app',
    //         'mylifedb',
    //         'inbox',
    //         inboxItem.folderName,
    //         'url.txt'
    //       );
    //       const url = await fs.readFile(urlPath, 'utf-8');
    //       const taskId = enqueueUrlEnrichment(inboxItem.id, url.trim());
    //       log.info({ taskId, inboxId: inboxItem.id }, 'enqueued url enrichment');
    //     } catch (error) {
    //       log.error({ err: error, inboxId: inboxItem.id }, 'failed to enqueue url enrichment');
    //       // Don't fail the request if task enqueue fails
    //     }
    //   }
    // }

    return NextResponse.json(inboxItem, { status: 201 });
  } catch (error) {
    log.error({ err: error }, 'create inbox item failed');
    return NextResponse.json(
      {
        error: 'Failed to create inbox item',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
const log = getLogger({ module: 'ApiInbox' });
