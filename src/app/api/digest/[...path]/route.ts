import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { DigestCoordinator } from '@/lib/digest/coordinator';
import { getDatabase } from '@/lib/db/connection';
import { getFileByPath } from '@/lib/db/files';
import { getDigestStatusView } from '@/lib/inbox/status-view';
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

    log.info({ filePath }, 'starting digest processing');

    // Create coordinator and process file
    const db = getDatabase();
    const coordinator = new DigestCoordinator(db);

    // Process file (runs synchronously but returns void)
    await coordinator.processFile(filePath);

    return NextResponse.json({
      success: true,
      message: 'Digest processing started. Check logs for progress.'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'failed to process file');
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
