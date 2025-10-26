// Settings storage and persistence using SQLite
import type { UserSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import { getDatabase } from '../db/connection';

/**
 * Load user settings from database
 */
export async function loadSettings(): Promise<UserSettings> {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;

    if (!row) {
      // No settings found, return defaults
      console.log('No settings found in database, using defaults');
      return DEFAULT_SETTINGS;
    }

    const settings = JSON.parse(row.data) as UserSettings;

    // Merge with defaults to ensure all fields exist
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        ...settings.preferences,
      },
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...settings.ai,
      },
      vendors: {
        ...DEFAULT_SETTINGS.vendors,
        ...settings.vendors,
      },
      extraction: {
        ...DEFAULT_SETTINGS.extraction,
        ...settings.extraction,
      },
      storage: {
        ...DEFAULT_SETTINGS.storage,
        ...settings.storage,
      },
    };
  } catch (error) {
    console.error('Error loading settings from database:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save user settings to database
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
  try {
    const db = getDatabase();
    const data = JSON.stringify(settings);

    // Use INSERT OR REPLACE to upsert the settings
    const stmt = db.prepare(`
      INSERT INTO settings (id, data) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `);

    stmt.run(data);
  } catch (error) {
    console.error('Failed to save settings to database:', error);
    throw new Error('Failed to save settings');
  }
}

/**
 * Update partial settings (merge with existing)
 */
export async function updateSettings(
  updates: Partial<UserSettings>
): Promise<UserSettings> {
  const currentSettings = await loadSettings();

  const updatedSettings: UserSettings = {
    ...currentSettings,
    ...updates,
    preferences: {
      ...currentSettings.preferences,
      ...updates.preferences,
    },
    ai: {
      ...currentSettings.ai,
      ...updates.ai,
    },
    vendors: {
      ...currentSettings.vendors,
      ...updates.vendors,
    },
    extraction: {
      ...currentSettings.extraction,
      ...updates.extraction,
    },
    storage: {
      ...currentSettings.storage,
      ...updates.storage,
    },
  };

  await saveSettings(updatedSettings);
  return updatedSettings;
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(): Promise<UserSettings> {
  await saveSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

/**
 * Get AI configuration only
 */
export async function getAIConfig() {
  const settings = await loadSettings();
  return settings.ai;
}

/**
 * Update AI configuration only
 */
export async function updateAIConfig(aiConfig: Partial<UserSettings['ai']>) {
  const settings = await loadSettings();
  settings.ai = {
    ...settings.ai,
    ...aiConfig,
  };
  await saveSettings(settings);
  return settings.ai;
}
