/**
 * Task Queue API - Pause worker
 * POST /api/tasks/worker/pause - Pause the task worker
 */

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { pauseWorker, getWorker } from '@/lib/task-queue/worker';

/**
 * POST /api/tasks/worker/pause
 * Pause the task worker
 */
export async function POST() {
  try {
    pauseWorker();
    const worker = getWorker();

    return NextResponse.json({
      success: true,
      status: {
        running: worker.isRunning(),
        paused: worker.isPaused(),
      },
    });
  } catch (error) {
    console.error('[API] POST /api/tasks/worker/pause error:', error);
    return NextResponse.json(
      { error: 'Failed to pause worker' },
      { status: 500 }
    );
  }
}
