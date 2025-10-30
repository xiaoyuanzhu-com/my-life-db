/**
 * Task Queue API - Worker status
 * GET /api/tasks/worker/status - Get worker status
 */

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getWorker } from '@/lib/task-queue/worker';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiWorkerStatus' });

/**
 * GET /api/tasks/worker/status
 * Get worker status
 */
export async function GET() {
  try {
    const worker = getWorker();

    return NextResponse.json({
      running: worker.isRunning(),
      paused: worker.isPaused(),
    });
  } catch (error) {
    log.error({ err: error }, 'get worker status failed');
    return NextResponse.json(
      { error: 'Failed to fetch worker status' },
      { status: 500 }
    );
  }
}
