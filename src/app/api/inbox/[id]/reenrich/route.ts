import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getFileByPath } from '@/lib/db/files';
import { processFileDigests } from '@/lib/digest/task-handler';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxReenrich' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/reenrich
 * Re-process an inbox item through all digesters
 *
 * Note: The 'stage' parameter is deprecated. This endpoint now runs all digesters.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    log.info({ filePath }, 'reenriching inbox item');

    // Process digests synchronously so user gets immediate feedback
    // Reset existing digests so all digesters run fresh (this is a re-enrich after all!)
    await processFileDigests(filePath, { reset: true });

    return NextResponse.json({
      success: true,
      message: 'Digest processing complete. All applicable digesters have run.'
    });
  } catch (error) {
    log.error({ err: error }, 'reenrich inbox item failed');
    return NextResponse.json({ error: 'Failed to reenrich inbox item' }, { status: 500 });
  }
}
