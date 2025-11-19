import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getTaskStats } from '@/lib/task-queue/task-manager';
import { getPendingTaskCountByType, hasReadyTasks } from '@/lib/task-queue/scheduler';
import { getWorker } from '@/lib/task-queue/worker';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiTaskStatus' });

export async function GET() {
  try {
    const stats = getTaskStats();
    const pendingByType = getPendingTaskCountByType();
    const hasReady = hasReadyTasks();
    const worker = getWorker();

    return NextResponse.json({
      queue: {
        ...stats,
        pending_by_type: pendingByType,
        has_ready_tasks: hasReady,
      },
      worker: {
        running: worker.isRunning(),
        paused: worker.isPaused(),
        active_tasks: worker.getActiveTaskCount(),
      },
    });
  } catch (error) {
    log.error({ err: error }, 'get task status failed');
    return NextResponse.json(
      { error: 'Failed to fetch task status' },
      { status: 500 }
    );
  }
}
