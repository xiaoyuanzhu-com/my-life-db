/**
 * Task Queue API - Single task operations
 * GET /api/tasks/:id - Get task details
 * DELETE /api/tasks/:id - Delete task
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTaskById, deleteTask } from '@/lib/task-queue/task-manager';

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/tasks/:id
 * Get task by ID
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const task = getTaskById(id);

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('[API] GET /api/tasks/:id error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch task' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/tasks/:id
 * Delete task by ID
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const deleted = deleteTask(id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Task not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[API] DELETE /api/tasks/:id error:', error);
    return NextResponse.json(
      { error: 'Failed to delete task' },
      { status: 500 }
    );
  }
}
