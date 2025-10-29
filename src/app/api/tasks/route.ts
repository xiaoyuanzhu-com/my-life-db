/**
 * Task Queue API - List and create tasks
 * GET /api/tasks - List tasks
 * POST /api/tasks - Create new task (manual enqueue)
 */

import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getTasks, createTask, getTaskStats } from '@/lib/task-queue/task-manager';
import type { TaskStatus } from '@/lib/task-queue/types';

/**
 * GET /api/tasks
 * List tasks with optional filtering
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') as TaskStatus | null;
    const type = searchParams.get('type');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const includeStats = searchParams.get('stats') === 'true';

    const filters: Parameters<typeof getTasks>[0] = {
      limit,
      offset,
    };

    if (status) {
      filters.status = status;
    }

    if (type) {
      filters.type = type;
    }

    const tasks = getTasks(filters);

    const response: {
      tasks: typeof tasks;
      total: number;
      limit: number;
      offset: number;
      stats?: ReturnType<typeof getTaskStats>;
    } = {
      tasks,
      total: tasks.length, // TODO: Get actual total count
      limit,
      offset,
    };

    if (includeStats) {
      response.stats = getTaskStats();
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('[API] GET /api/tasks error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks
 * Create a new task (manual enqueue)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, payload, run_after } = body;

    if (!type || typeof type !== 'string') {
      return NextResponse.json(
        { error: 'Task type is required' },
        { status: 400 }
      );
    }

    if (!payload || typeof payload !== 'object') {
      return NextResponse.json(
        { error: 'Task payload is required' },
        { status: 400 }
      );
    }

    const task = createTask({
      type,
      payload,
      run_after,
    });

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error('[API] POST /api/tasks error:', error);
    return NextResponse.json(
      { error: 'Failed to create task' },
      { status: 500 }
    );
  }
}
