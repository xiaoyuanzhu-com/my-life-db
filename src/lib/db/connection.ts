// Database connection and initialization
import 'server-only';
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
  const appDir = join(baseDir, 'app', 'mylifedb');

  // Ensure directory exists
  if (!existsSync(appDir)) {
    mkdirSync(appDir, { recursive: true });
  }

  return join(appDir, 'database.sqlite');
}

/**
 * Get or create database connection
 */
export function getDatabase(): BetterSqlite3.Database {
  if (!db) {
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
 * Close database connection (useful for cleanup)
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
