/**
 * Setting - Settings table models
 *
 * Simple key-value store for application settings.
 */

/**
 * Setting record row (snake_case - matches SQLite schema exactly)
 */
export interface SettingRecordRow {
  /** Setting key (unique identifier) */
  key: string;

  /** Setting value (stored as string, may be JSON) */
  value: string;

  /** ISO 8601 timestamp when setting was last updated */
  updated_at: string;
}

/**
 * Setting record (camelCase - for TypeScript usage)
 */
export interface Setting {
  /** Setting key (unique identifier) */
  key: string;

  /** Setting value (stored as string, may be JSON) */
  value: string;

  /** ISO 8601 timestamp when setting was last updated */
  updatedAt: string;
}

/**
 * Conversion helper: SettingRecordRow → Setting
 */
export function rowToSetting(row: SettingRecordRow): Setting {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}
