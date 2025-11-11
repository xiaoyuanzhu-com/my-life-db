import { getDatabase } from './connection';
import type { TaskStatus } from '@/lib/task-queue/types';

export interface InboxTaskState {
  itemId: string;
  taskType: string;
  status: TaskStatus;
  taskId: string | null;
  attempts: number;
  error: string | null;
  updatedAt: number; // Unix seconds
}

interface InboxTaskStateRecord {
  item_id: string;
  task_type: string;
  status: TaskStatus;
  task_id: string | null;
  attempts: number;
  error: string | null;
  updated_at: number;
}

/**
 * Convert database record to InboxTaskState
 */
function recordToTaskState(record: InboxTaskStateRecord): InboxTaskState {
  return {
    itemId: record.item_id,
    taskType: record.task_type,
    status: record.status,
    taskId: record.task_id,
    attempts: record.attempts,
    error: record.error,
    updatedAt: record.updated_at,
  };
}

export function upsertInboxTaskState(input: {
  itemId: string;
  taskType: string;
  status: TaskStatus;
  taskId?: string | null;
  attempts?: number;
  error?: string | null;
}): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO inbox_task_state (item_id, task_type, status, task_id, attempts, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, task_type) DO UPDATE SET
      status = excluded.status,
      task_id = COALESCE(excluded.task_id, inbox_task_state.task_id),
      attempts = COALESCE(excluded.attempts, inbox_task_state.attempts),
      error = excluded.error,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    input.itemId,
    input.taskType,
    input.status,
    input.taskId ?? null,
    input.attempts ?? 0,
    input.error ?? null,
    now
  );
}

export function setInboxTaskState(input: {
  itemId: string;
  taskType: string;
  status: TaskStatus;
  taskId?: string | null;
  attempts?: number;
  error?: string | null;
}): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO inbox_task_state (item_id, task_type, status, task_id, attempts, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, task_type) DO UPDATE SET
      status = excluded.status,
      task_id = excluded.task_id,
      attempts = excluded.attempts,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    input.itemId,
    input.taskType,
    input.status,
    input.taskId ?? null,
    input.attempts ?? 0,
    input.error ?? null,
    now
  );
}

export function getInboxTaskStatesByItemId(itemId: string): InboxTaskState[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM inbox_task_state WHERE item_id = ? ORDER BY task_type ASC')
    .all(itemId) as InboxTaskStateRecord[];
  return rows.map(recordToTaskState);
}

export function getInboxTaskState(itemId: string, taskType: string): InboxTaskState | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM inbox_task_state WHERE item_id = ? AND task_type = ?')
    .get(itemId, taskType) as InboxTaskStateRecord | undefined;
  return row ? recordToTaskState(row) : null;
}

export function getInboxTaskStatesForItemIds(
  itemIds: string[]
): Record<string, InboxTaskState[]> {
  const db = getDatabase();
  if (itemIds.length === 0) return {};

  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM inbox_task_state WHERE item_id IN (${placeholders}) ORDER BY item_id, task_type`)
    .all(...itemIds) as InboxTaskStateRecord[];

  const grouped: Record<string, InboxTaskState[]> = {};
  for (const row of rows) {
    const state = recordToTaskState(row);
    if (!grouped[state.itemId]) grouped[state.itemId] = [];
    grouped[state.itemId].push(state);
  }
  return grouped;
}
