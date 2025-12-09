import { dbRun, dbSelectOne } from './client';

/**
 * Read a single setting value by key
 */
export function getSettingValue(key: string): string | null {
  const row = dbSelectOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

/**
 * Upsert a single setting value by key
 */
export function setSettingValue(key: string, value: string): void {
  dbRun(
    `
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    [key, value]
  );
}
