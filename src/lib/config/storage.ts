// Settings storage and persistence
import { promises as fs } from 'fs';
import path from 'path';
import type { UserSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';

const DATA_ROOT = path.join(process.cwd(), 'data');
const APP_CONFIG_DIR = path.join(DATA_ROOT, 'apps', 'mylifedb');
const SETTINGS_FILE = path.join(APP_CONFIG_DIR, 'config.json');

/**
 * Load user settings from disk
 */
export async function loadSettings(): Promise<UserSettings> {
  try {
    // Ensure app config directory exists
    await fs.mkdir(APP_CONFIG_DIR, { recursive: true });

    // Try to read settings file
    const content = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const settings = JSON.parse(content) as UserSettings;

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
    // If file doesn't exist or is invalid, return defaults
    console.log('No settings file found, using defaults');
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save user settings to disk
 */
export async function saveSettings(settings: UserSettings): Promise<void> {
  try {
    // Ensure app config directory exists
    await fs.mkdir(APP_CONFIG_DIR, { recursive: true });

    // Write settings to file
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save settings:', error);
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
