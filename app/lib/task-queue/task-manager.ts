/**
 * Task Manager - CRUD operations for task queue
 */

import { generateUUIDv7 } from './uuid';
import type { Task, TaskInput, TaskStatus } from './types';
import { dbRun, dbSelect, dbSelectOne, dbTransaction } from '~/lib/db/client';
import { getLogger } from '~/lib/log/logger';

const log = getLogger({ module: 'TaskManager' });

export interface CreateTaskInput {
  type: string;
  input: TaskInput;
  run_after?: number; // Unix timestamp (seconds)
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  attempts?: number;
  last_attempt_at?: number;
  output?: unknown | null;
  error?: string | null;
  version?: number;
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput): Task {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
  const id = generateUUIDv7();

  dbRun(
    `
      INSERT INTO tasks (
        id, type, input, status, version, attempts,
        run_after, created_at, updated_at
      ) VALUES (?, ?, ?, 'to-do', 0, 0, ?, ?, ?)
    `,
    [
      id,
      input.type,
      JSON.stringify(input.input),
      input.run_after || null,
      now,
      now,
    ]
  );

  const created = getTaskById(id)!;
  return created;
}

/**
 * Get task by ID
 */
export function getTaskById(id: string): Task | null {
  return dbSelectOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
}

/**
 * Get tasks by type and status
 */
export function getTasksByType(
  type: string,
  status?: TaskStatus
): Task[] {
  let query = 'SELECT * FROM tasks WHERE type = ?';
  const params: unknown[] = [type];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  return dbSelect<Task>(query, params);
}

/**
 * Get all tasks (with optional filters)
 */
export function getTasks(filters?: {
  status?: TaskStatus;
  type?: string;
  limit?: number;
  offset?: number;
}): Task[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters?.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  let query = 'SELECT * FROM tasks';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  if (filters?.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  if (filters?.offset) {
    query += ' OFFSET ?';
    params.push(filters.offset);
  }

  return dbSelect<Task>(query, params);
}

/**
 * Update task with optimistic locking
 * @returns true if update succeeded, false if version mismatch (stale)
 */
export function updateTask(
  id: string,
  updates: UpdateTaskInput,
  expectedVersion: number
): boolean {
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

  // Pre-read for logging when transitioning to terminal states
  const shouldLogOutcome = updates.status === 'success' || updates.status === 'failed';
  const prev = shouldLogOutcome ? getTaskById(id) : null;

  const setClauses: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);

    // Set completed_at when transitioning to success/failed
    if (updates.status === 'success' || updates.status === 'failed') {
      setClauses.push('completed_at = ?');
      params.push(now);
    }
  }

  if (updates.attempts !== undefined) {
    setClauses.push('attempts = ?');
    params.push(updates.attempts);
  }

  if (updates.last_attempt_at !== undefined) {
    setClauses.push('last_attempt_at = ?');
    params.push(updates.last_attempt_at);
  }

  if (updates.output !== undefined) {
    setClauses.push('output = ?');
    params.push(
      updates.output === null || updates.output === undefined
        ? null
        : JSON.stringify(updates.output)
    );
  }

  if (updates.error !== undefined) {
    setClauses.push('error = ?');
    params.push(updates.error);
  }

  // Increment version for optimistic locking
  const newVersion = (updates.version !== undefined) ? updates.version : expectedVersion + 1;
  setClauses.push('version = ?');
  params.push(newVersion);

  // WHERE clause: id and version match
  params.push(id);
  params.push(expectedVersion);

  const result = dbRun(
    `
      UPDATE tasks
      SET ${setClauses.join(', ')}
      WHERE id = ? AND version = ?
    `,
    params
  );
  const updated = result.changes > 0;

  if (updated && shouldLogOutcome) {
    log.info(
      {
        id,
        from: prev?.status,
        to: updates.status,
        attempts: updates.attempts ?? prev?.attempts,
        version: newVersion,
      },
      'task status updated'
    );
  }

  return updated;
}

/**
 * Delete task by ID
 */
export function deleteTask(id: string): boolean {
  const result = dbRun('DELETE FROM tasks WHERE id = ?', [id]);
  return result.changes > 0;
}

/**
 * Delete all tasks with a specific status
 */
export function deleteTasksByStatus(status: TaskStatus): number {
  const result = dbRun('DELETE FROM tasks WHERE status = ?', [status]);
  return result.changes;
}

/**
 * Get task statistics
 */
export function getTaskStats(): {
  total: number;
  by_status: Record<TaskStatus, number>;
  by_type: Record<string, number>;
} {
  const total = dbSelectOne<{ count: number }>('SELECT COUNT(*) as count FROM tasks')?.count ?? 0;

  const statusRows = dbSelect<{ status: TaskStatus; count: number }>(
    `
      SELECT status, COUNT(*) as count
      FROM tasks
      GROUP BY status
    `
  );

  const typeRows = dbSelect<{ type: string; count: number }>(
    `
      SELECT type, COUNT(*) as count
      FROM tasks
      GROUP BY type
    `
  );

  const by_status: Record<string, number> = {
    'to-do': 0,
    'in-progress': 0,
    'success': 0,
    'failed': 0,
  };

  statusRows.forEach(row => {
    by_status[row.status] = row.count;
  });

  const by_type: Record<string, number> = {};
  typeRows.forEach(row => {
    by_type[row.type] = row.count;
  });

  return {
    total,
    by_status: by_status as Record<TaskStatus, number>,
    by_type,
  };
}

/**
 * Clean up old completed tasks
 */
export function cleanupOldTasks(olderThanSeconds: number): number {
  const cutoffTime = Math.floor(Date.now() / 1000) - olderThanSeconds;

  const result = dbRun(
    `
      DELETE FROM tasks
      WHERE status IN ('success', 'failed')
        AND completed_at < ?
    `,
    [cutoffTime]
  );
  return result.changes;
}

/**
 * Delete pending or in-progress tasks referencing a specific file path
 */
export function deletePendingTasksForFile(filePath: string): number {
  const likePath = `%\"filePath\":\"${filePath}\"%`;
  const likePathSnake = `%\"file_path\":\"${filePath}\"%`;

  const tasks = dbSelect<{ id: string; type: string; input: string }>(
    `
      SELECT id, type, input FROM tasks
      WHERE status IN ('to-do', 'in-progress')
        AND (input LIKE ? OR input LIKE ?)
    `,
    [likePath, likePathSnake]
  );

  let deletedCount = 0;

  dbTransaction(() => {
    for (const task of tasks) {
      try {
        const input = JSON.parse(task.input);
        if (input.filePath === filePath || input.file_path === filePath) {
          dbRun('DELETE FROM tasks WHERE id = ?', [task.id]);
          deletedCount++;
          log.debug({ taskId: task.id, taskType: task.type, filePath }, 'deleted task for file');
        }
      } catch (error) {
        log.warn({ taskId: task.id, error }, 'failed to parse task input');
      }
    }
  });

  return deletedCount;
}

/**
 * Delete pending or in-progress tasks referencing paths under a prefix
 */
export function deletePendingTasksForPrefix(pathPrefix: string): number {
  const likePath = `%\"filePath\":\"${pathPrefix}%\"%`;
  const likePathSnake = `%\"file_path\":\"${pathPrefix}%\"%`;

  const tasks = dbSelect<{ id: string; type: string; input: string }>(
    `
      SELECT id, type, input FROM tasks
      WHERE status IN ('to-do', 'in-progress')
        AND (input LIKE ? OR input LIKE ?)
    `,
    [likePath, likePathSnake]
  );

  let deletedCount = 0;

  dbTransaction(() => {
    for (const task of tasks) {
      try {
        const input = JSON.parse(task.input);
        const taskFilePath = input.filePath || input.file_path;

        if (taskFilePath && typeof taskFilePath === 'string' && taskFilePath.startsWith(pathPrefix)) {
          dbRun('DELETE FROM tasks WHERE id = ?', [task.id]);
          deletedCount++;
          log.debug({ taskId: task.id, taskType: task.type, filePath: taskFilePath }, 'deleted task for file prefix');
        }
      } catch (error) {
        log.warn({ taskId: task.id, error }, 'failed to parse task input');
      }
    }
  });

  return deletedCount;
}
