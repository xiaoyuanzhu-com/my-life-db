import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { DigestCoordinator } from '@/lib/digest/coordinator';
import { getDatabase } from '@/lib/db/connection';
import { getFileByPath } from '@/lib/db/files';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxDigest' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/digest
 *
 * Process file through digest system
 * Runs all applicable digesters on the file
 *
 * Examples:
 * - POST /api/inbox/foo.txt/digest → process file through all digesters
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
    log.error({ err: error, filePath: `inbox/${(await context.params).id}` }, 'failed to process file');
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
