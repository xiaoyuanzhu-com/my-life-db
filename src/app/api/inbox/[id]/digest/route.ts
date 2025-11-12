import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { startDigestWorkflow } from '@/lib/inbox/digestWorkflow';
import { getFileByPath } from '@/lib/db/files';
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
    const filePath = `inbox/${id}`;

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    // Start digest workflow (type detection happens inside)
    const { taskId } = await startDigestWorkflow(filePath);

    return NextResponse.json({ success: true, taskId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'failed to start digest workflow');
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
