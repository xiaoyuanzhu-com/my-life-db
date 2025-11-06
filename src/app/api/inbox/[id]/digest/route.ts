import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { startUrlDigestWorkflow } from '@/lib/inbox/digestWorkflow';
import { getInboxItemById } from '@/lib/db/inbox';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxDigestWorkflow' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;

    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    if (item.type !== 'url') {
      return NextResponse.json({ error: 'Digest workflow not available for this item type' }, { status: 400 });
    }

    const { taskId } = await startUrlDigestWorkflow(id);

    return NextResponse.json({ success: true, taskId });
  } catch (error) {
    log.error({ err: error }, 'failed to start digest workflow');
    return NextResponse.json({ error: 'Failed to start digest workflow' }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
