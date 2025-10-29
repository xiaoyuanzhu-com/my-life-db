// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { createInboxEntry } from '@/lib/inbox/createInboxEntry';
import { listInboxItems } from '@/lib/db/inbox';
import { enqueueUrlProcessing } from '@/lib/inbox/processUrlInboxItem';
import { getStorageConfig } from '@/lib/config/storage';

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

    return NextResponse.json({
      items,
      total: items.length,
    });
  } catch (error) {
    console.error('Error listing inbox items:', error);
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

    // Trigger URL processing if inbox item type is 'url'
    if (inboxItem.type === 'url') {
      const urlFile = inboxItem.files.find(f => f.filename === 'url.txt');
      if (urlFile) {
        try {
          // Read URL from file and enqueue processing
          const storageConfig = await getStorageConfig();
          const urlPath = path.join(
            storageConfig.dataPath,
            '.app',
            'mylifedb',
            'inbox',
            inboxItem.folderName,
            'url.txt'
          );
          const url = await fs.readFile(urlPath, 'utf-8');
          const taskId = enqueueUrlProcessing(inboxItem.id, url.trim());
          console.log(`[API] Enqueued URL processing task ${taskId} for inbox item ${inboxItem.id}`);
        } catch (error) {
          console.error('[API] Failed to enqueue URL processing:', error);
          // Don't fail the request if task enqueue fails
        }
      }
    }

    return NextResponse.json(inboxItem, { status: 201 });
  } catch (error) {
    console.error('Error creating inbox item:', error);
    return NextResponse.json(
      {
        error: 'Failed to create inbox item',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
