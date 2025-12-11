// Database connection and initialization
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { runMigrations } from './migrations';

let db: BetterSqlite3.Database | null = null;
let migrationsEnsured = false;

/**
 * Get the database file path based on MY_DATA_DIR environment variable
 */
export function getDatabasePath(): string {
  const baseDir = process.env.MY_DATA_DIR || './data';
  const appDir = join(baseDir, 'app', 'my-life-db');

  return join(appDir, 'database.sqlite');
}

/**
 * Ensure database directory exists
 * Separated from getDatabasePath to allow better error handling
 */
function ensureDatabaseDirectory(): void {
  const baseDir = process.env.MY_DATA_DIR || './data';
  const appDir = join(baseDir, 'app', 'my-life-db');

  try {
    if (!existsSync(appDir)) {
      mkdirSync(appDir, { recursive: true });
    }
  } catch (error) {
    // Provide detailed error message for debugging
    const err = error as Error;
    throw new Error(
      `Failed to create database directory at ${appDir}: ${err.message}. ` +
      `Ensure MY_DATA_DIR (${baseDir}) is writable and the parent directory exists.`
    );
  }
}

/**
 * Internal: Get or create database connection.
 * Use db/client helpers instead of calling this directly.
 */
export function getDatabaseInternal(): BetterSqlite3.Database {
  if (!db) {
    ensureDatabaseDirectory();
    const dbPath = getDatabasePath();
    db = new Database(dbPath);

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Optimize page cache (64MB)
    db.pragma('cache_size = -64000');
  }

  // Run migrations once per process to avoid noisy logs
  if (!migrationsEnsured) {
    runMigrations(db);
    migrationsEnsured = true;
  }

  return db;
}

/**
 * Internal cleanup helper
 */
export function closeDatabaseInternal() {
  if (db) {
    db.close();
    db = null;
  }
}
