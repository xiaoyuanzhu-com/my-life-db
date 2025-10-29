/**
 * Task Queue API - Resume worker
 * POST /api/tasks/worker/resume - Resume the task worker
 */

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { resumeWorker, getWorker } from '@/lib/task-queue/worker';

/**
 * POST /api/tasks/worker/resume
 * Resume the task worker
 */
export async function POST() {
  try {
    resumeWorker();
    const worker = getWorker();

    return NextResponse.json({
      success: true,
      status: {
        running: worker.isRunning(),
        paused: worker.isPaused(),
      },
    });
  } catch (error) {
    console.error('[API] POST /api/tasks/worker/resume error:', error);
    return NextResponse.json(
      { error: 'Failed to resume worker' },
      { status: 500 }
    );
  }
}
