import { getDatabase } from './connection';
import type { TaskStatus } from '@/lib/task-queue/types';

export interface InboxTaskState {
  inbox_id: string;
  task_type: string;
  status: TaskStatus;
  task_id: string | null;
  attempts: number;
  error: string | null;
  updated_at: number; // Unix seconds
}

export function upsertInboxTaskState(input: {
  inboxId: string;
  taskType: string;
  status: TaskStatus;
  taskId?: string | null;
  attempts?: number;
  error?: string | null;
}): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO inbox_task_state (inbox_id, task_type, status, task_id, attempts, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inbox_id, task_type) DO UPDATE SET
      status = excluded.status,
      task_id = COALESCE(excluded.task_id, inbox_task_state.task_id),
      attempts = COALESCE(excluded.attempts, inbox_task_state.attempts),
      error = excluded.error,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    input.inboxId,
    input.taskType,
    input.status,
    input.taskId ?? null,
    input.attempts ?? 0,
    input.error ?? null,
    now
  );
}

export function getInboxTaskStates(inboxId: string): InboxTaskState[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM inbox_task_state WHERE inbox_id = ? ORDER BY task_type ASC')
    .all(inboxId) as InboxTaskState[];
  return rows;
}

export function getInboxTaskState(inboxId: string, taskType: string): InboxTaskState | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM inbox_task_state WHERE inbox_id = ? AND task_type = ?')
    .get(inboxId, taskType) as InboxTaskState | undefined;
  return row ?? null;
}

export function getInboxTaskStatesForInboxIds(
  inboxIds: string[]
): Record<string, InboxTaskState[]> {
  const db = getDatabase();
  if (inboxIds.length === 0) return {};

  const placeholders = inboxIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM inbox_task_state WHERE inbox_id IN (${placeholders}) ORDER BY inbox_id, task_type`)
    .all(...inboxIds) as InboxTaskState[];

  const grouped: Record<string, InboxTaskState[]> = {};
  for (const row of rows) {
    if (!grouped[row.inbox_id]) grouped[row.inbox_id] = [];
    grouped[row.inbox_id].push(row);
  }
  return grouped;
}
