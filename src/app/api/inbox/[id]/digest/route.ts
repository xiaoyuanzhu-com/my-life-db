import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { startDigestWorkflow, startDigestStep } from '@/lib/inbox/digestWorkflow';
import { getFileByPath } from '@/lib/db/files';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxDigestWorkflow' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/digest
 *
 * Start digest workflow or individual digest step
 *
 * Query params:
 * - step: Optional digest step to run (e.g., 'index', 'summary', 'tagging', 'slug')
 *         If not provided, runs the full digest workflow
 *
 * Examples:
 * - POST /api/inbox/foo.md/digest → full workflow
 * - POST /api/inbox/foo.md/digest?step=index → index step only
 * - POST /api/inbox/foo.md/digest?step=summary → summary step only
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

    // Check if user wants to run a specific step
    const { searchParams } = new URL(request.url);
    const step = searchParams.get('step');

    if (step) {
      // Run individual step
      const { taskId } = await startDigestStep(filePath, step);
      return NextResponse.json({ success: true, taskId, step });
    }

    // Run full workflow (type detection happens inside)
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
