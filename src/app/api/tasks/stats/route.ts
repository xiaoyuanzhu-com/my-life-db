/**
 * Task Queue API - Statistics
 * GET /api/tasks/stats - Get task queue statistics
 */

import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getTaskStats } from '@/lib/task-queue/task-manager';
import { getPendingTaskCountByType, hasReadyTasks } from '@/lib/task-queue/scheduler';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiTaskStats' });

/**
 * GET /api/tasks/stats
 * Get task queue statistics
 */
export async function GET() {
  try {
    const basicStats = getTaskStats();
    const pendingByType = getPendingTaskCountByType();
    const hasReady = hasReadyTasks();

    const stats = {
      ...basicStats,
      pending_by_type: pendingByType,
      has_ready_tasks: hasReady,
    };

    return NextResponse.json(stats);
  } catch (error) {
    log.error({ err: error }, 'get task stats failed');
    return NextResponse.json(
      { error: 'Failed to fetch task statistics' },
      { status: 500 }
    );
  }
}
