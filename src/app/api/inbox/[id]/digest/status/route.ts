import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getInboxStatusView } from '@/lib/inbox/statusView';
import { getInboxItemById } from '@/lib/db/inbox';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxDigestStatus' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const status = getInboxStatusView(id);
    return NextResponse.json({ status });
  } catch (error) {
    log.error({ err: error }, 'failed to fetch digest status');
    return NextResponse.json({ error: 'Failed to fetch digest status' }, { status: 500 });
  }
}
