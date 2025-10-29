/**
 * Task Queue API - Worker status
 * GET /api/tasks/worker/status - Get worker status
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorker } from '@/lib/task-queue/worker';

/**
 * GET /api/tasks/worker/status
 * Get worker status
 */
export async function GET(request: NextRequest) {
  try {
    const worker = getWorker();

    return NextResponse.json({
      running: worker.isRunning(),
      paused: worker.isPaused(),
    });
  } catch (error) {
    console.error('[API] GET /api/tasks/worker/status error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worker status' },
      { status: 500 }
    );
  }
}
