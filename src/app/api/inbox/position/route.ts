import { NextRequest, NextResponse } from 'next/server';
import { getFilePosition } from '@/lib/db/files';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxPosition' });

export const runtime = 'nodejs';

const BATCH_SIZE = 30; // Match InboxFeed batch size

/**
 * GET /api/inbox/position?path=inbox/foo
 * Returns the position of an item in the inbox list
 */
export async function GET(request: NextRequest) {
  try {
    const path = request.nextUrl.searchParams.get('path');

    if (!path) {
      return NextResponse.json(
        { error: 'Path is required' },
        { status: 400 }
      );
    }

    const result = getFilePosition(path, 'inbox/', 'created_at', false);

    if (!result) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    // Calculate batch offset (round down to nearest batch boundary)
    const batchOffset = Math.floor(result.position / BATCH_SIZE) * BATCH_SIZE;

    return NextResponse.json({
      path,
      position: result.position,
      total: result.total,
      batchOffset,
      batchSize: BATCH_SIZE,
    });
  } catch (error) {
    log.error({ err: error }, 'get position failed');
    return NextResponse.json(
      { error: 'Failed to get position' },
      { status: 500 }
    );
  }
}
