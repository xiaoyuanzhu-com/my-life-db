import type BetterSqlite3 from 'better-sqlite3';
import { getDatabaseInternal } from './connection';
import { getLogger } from '~/lib/log/logger';

type QueryParam = unknown;
type QueryParams = QueryParam[] | readonly QueryParam[];

const log = getLogger({ module: 'DBClient' });
const shouldLogQueries = process.env.DB_LOG_QUERIES === '1';

function logQuery(kind: 'select' | 'get' | 'run' | 'tx', sql: string, params: QueryParams): void {
  if (!shouldLogQueries) return;
  log.debug({ kind, sql, params }, 'db query');
}

/**
 * Run a SELECT returning multiple rows
 */
export function dbSelect<T = Record<string, unknown>>(sql: string, params: QueryParams = []): T[] {
  logQuery('select', sql, params);
  const db = getDatabaseInternal();
  return db.prepare(sql).all(...params) as T[];
}

/**
 * Run a SELECT returning a single row (or null)
 */
export function dbSelectOne<T = Record<string, unknown>>(sql: string, params: QueryParams = []): T | null {
  logQuery('get', sql, params);
  const db = getDatabaseInternal();
  const row = db.prepare(sql).get(...params) as T | undefined;
  return row ?? null;
}

/**
 * Run INSERT/UPDATE/DELETE
 */
export function dbRun(sql: string, params: QueryParams = []): BetterSqlite3.RunResult {
  logQuery('run', sql, params);
  const db = getDatabaseInternal();
  return db.prepare(sql).run(...params);
}

/**
 * Execute a function inside a SQLite transaction
 */
export function dbTransaction<T>(fn: () => T): T {
  logQuery('tx', 'BEGIN', []);
  const db = getDatabaseInternal();
  const run = db.transaction(fn);
  return run();
}

/**
 * Ensure the database is opened and migrations have run
 */
export function ensureDatabaseReady(): BetterSqlite3.Database {
  const db = getDatabaseInternal();
  return db;
}

/**
 * Access the underlying database instance when needed (e.g., libraries needing the raw connection)
 * Prefer dbSelect/dbRun/dbTransaction where possible.
 */
export function withDatabase<T>(fn: (db: BetterSqlite3.Database) => T): T {
  const db = getDatabaseInternal();
  return fn(db);
}
