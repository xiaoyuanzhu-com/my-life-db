// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { createInboxItem } from '@/lib/inbox/createItem';
import { listItems } from '@/lib/db/items';
import { listDigestsForItem } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';

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

    // List items in inbox location
    const items = listItems({ location: 'inbox', status, limit, offset });

    // Include digests for each item
    const itemsWithDigests = items.map((item) => {
      const digests = listDigestsForItem(item.id);
      return {
        ...item,
        digests,
      };
    });

    return NextResponse.json({
      items: itemsWithDigests,
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

    // Create inbox item
    const item = await createInboxItem({
      text: text || undefined,
      files,
    });

    log.info({ itemId: item.id, path: item.path }, 'created inbox item');

    return NextResponse.json(item, { status: 201 });
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
