import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getFileByPath } from '@/lib/db/files';
import { getDigestStatusView } from '@/lib/inbox/status-view';
import { processFileDigests } from '@/lib/digest/task-handler';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiDigest' });

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

/**
 * GET /api/digest/[...path]
 *
 * Get digest status for any file
 *
 * Examples:
 * - GET /api/digest/inbox/foo.txt
 * - GET /api/digest/notes/my-note.md
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { path } = await context.params;
    const filePath = path.join('/');

    if (!filePath) {
      return NextResponse.json({ error: 'Missing file path' }, { status: 400 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const status = getDigestStatusView(filePath);
    return NextResponse.json({ status });
  } catch (error) {
    log.error({ err: error }, 'failed to fetch digest status');
    return NextResponse.json({ error: 'Failed to fetch digest status' }, { status: 500 });
  }
}

/**
 * POST /api/digest/[...path]
 *
 * Process any file through digest system
 * Runs all applicable digesters on the file
 *
 * Examples:
 * - POST /api/digest/inbox/foo.txt → process inbox file
 * - POST /api/digest/notes/my-note.md → process library file
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  let filePath: string | null = null;
  try {
    const { path } = await context.params;
    filePath = path.join('/');

    if (!filePath) {
      return NextResponse.json({ error: 'Missing file path' }, { status: 400 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    log.info({ filePath }, 'starting digest processing');

    // Process digests synchronously so user gets immediate feedback
    await processFileDigests(filePath);

    return NextResponse.json({
      success: true,
      message: 'Digest processing complete.'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof Error && error.message.includes('No digest workflow available')
        ? 400
        : 500;

    log.error({ err: error, filePath }, 'failed to enqueue digest workflow');
    return NextResponse.json({ error: errorMessage }, { status: statusCode });
  }
}
