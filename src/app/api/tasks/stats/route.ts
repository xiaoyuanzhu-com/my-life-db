/**
 * Task Queue API - Statistics
 * GET /api/tasks/stats - Get task queue statistics
 */

import { NextResponse } from 'next/server';
import { getTaskStats } from '@/lib/task-queue/task-manager';
import { getPendingTaskCountByType, hasReadyTasks } from '@/lib/task-queue/scheduler';

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
    console.error('[API] GET /api/tasks/stats error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task statistics' },
      { status: 500 }
    );
  }
}
