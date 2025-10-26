// Database connection and initialization
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

let db: BetterSqlite3.Database | null = null;

/**
 * Get the database file path based on MY_DATA_DIR environment variable
 */
export function getDatabasePath(): string {
  const baseDir = process.env.MY_DATA_DIR || './data';
  const appDir = join(baseDir, '.app', 'mylifedb');

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

    // Initialize schema
    initializeSchema(db);
  }

  return db;
}

/**
 * Initialize database schema
 */
function initializeSchema(database: BetterSqlite3.Database) {
  // Create settings table if it doesn't exist
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create trigger to update updated_at timestamp
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS settings_updated_at
    AFTER UPDATE ON settings
    BEGIN
      UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);
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
