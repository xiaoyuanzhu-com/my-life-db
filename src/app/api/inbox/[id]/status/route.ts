import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getInboxStatusView } from '@/lib/inbox/statusView';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxStatus' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const view = getInboxStatusView(id);
    if (!view) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }
    return NextResponse.json(view);
  } catch (error) {
    log.error({ err: error }, 'get inbox status failed');
    return NextResponse.json({ error: 'Failed to get inbox status' }, { status: 500 });
  }
}
