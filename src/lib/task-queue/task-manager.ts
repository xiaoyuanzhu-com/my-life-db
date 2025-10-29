/**
 * Task Manager - CRUD operations for task queue
 */

import { getDatabase } from '../db/connection';
import { generateUUIDv7 } from './uuid';
import type { Task, TaskPayload, TaskStatus } from './types';

export interface CreateTaskInput {
  type: string;
  payload: TaskPayload;
  run_after?: number; // Unix timestamp (seconds)
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  attempts?: number;
  last_attempt_at?: number;
  result?: TaskPayload | null;
  error?: string | null;
  version?: number;
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput): Task {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
  const id = generateUUIDv7();

  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, type, payload, status, version, attempts,
      run_after, created_at, updated_at
    ) VALUES (?, ?, ?, 'to-do', 0, 0, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.type,
    JSON.stringify(input.payload),
    input.run_after || null,
    now,
    now
  );

  return getTaskById(id)!;
}

/**
 * Get task by ID
 */
export function getTaskById(id: string): Task | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(id) as Task | undefined;
  return row || null;
}

/**
 * Get tasks by type and status
 */
export function getTasksByType(
  type: string,
  status?: TaskStatus
): Task[] {
  const db = getDatabase();

  let query = 'SELECT * FROM tasks WHERE type = ?';
  const params: unknown[] = [type];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const stmt = db.prepare(query);
  return stmt.all(...params) as Task[];
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
  const db = getDatabase();
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

  const stmt = db.prepare(query);
  return stmt.all(...params) as Task[];
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
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

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

  if (updates.result !== undefined) {
    setClauses.push('result = ?');
    params.push(updates.result ? JSON.stringify(updates.result) : null);
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

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${setClauses.join(', ')}
    WHERE id = ? AND version = ?
  `);

  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Delete task by ID
 */
export function deleteTask(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Delete all tasks with a specific status
 */
export function deleteTasksByStatus(status: TaskStatus): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM tasks WHERE status = ?');
  const result = stmt.run(status);
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
  const db = getDatabase();

  const total = (db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }).count;

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tasks
    GROUP BY status
  `).all() as Array<{ status: TaskStatus; count: number }>;

  const typeRows = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM tasks
    GROUP BY type
  `).all() as Array<{ type: string; count: number }>;

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
  const db = getDatabase();
  const cutoffTime = Math.floor(Date.now() / 1000) - olderThanSeconds;

  const stmt = db.prepare(`
    DELETE FROM tasks
    WHERE status IN ('success', 'failed')
      AND completed_at < ?
  `);

  const result = stmt.run(cutoffTime);
  return result.changes;
}
