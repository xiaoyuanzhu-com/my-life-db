import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getDigestStatusView } from '@/lib/inbox/status-view';
import { getFileByPath } from '@/lib/db/files';
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
    const filePath = `inbox/${id}`;
    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const status = getDigestStatusView(filePath);
    return NextResponse.json({ status });
  } catch (error) {
    log.error({ err: error }, 'failed to fetch digest status');
    return NextResponse.json({ error: 'Failed to fetch digest status' }, { status: 500 });
  }
}
