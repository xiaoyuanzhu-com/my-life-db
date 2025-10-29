// Settings storage and persistence using SQLite (key-value)
import type { UserSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import { getDatabase } from '../db/connection';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Get a single setting value by key
 */
function getSetting(db: BetterSqlite3.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * Set a single setting value by key
 */
function setSetting(db: BetterSqlite3.Database, key: string, value: string): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
}

/**
 * Load user settings from database
 */
export async function loadSettings(): Promise<UserSettings> {
  try {
    const db = getDatabase();

    // Load settings from key-value pairs
    const settings: UserSettings = {
      preferences: {
        theme: (getSetting(db, 'preferences_theme') as UserSettings['preferences']['theme']) || DEFAULT_SETTINGS.preferences.theme,
        defaultView: (getSetting(db, 'preferences_default_view') as UserSettings['preferences']['defaultView']) || DEFAULT_SETTINGS.preferences.defaultView,
        weeklyDigest: getSetting(db, 'preferences_weekly_digest') === 'true' || DEFAULT_SETTINGS.preferences.weeklyDigest,
        digestDay: parseInt(
          getSetting(db, 'preferences_digest_day') || String(DEFAULT_SETTINGS.preferences.digestDay)
        ) as UserSettings['preferences']['digestDay'],
      },
      ai: {
        provider: (getSetting(db, 'ai_provider') as UserSettings['ai']['provider']) || DEFAULT_SETTINGS.ai.provider,
        openai: {
          apiKey: getSetting(db, 'ai_openai_api_key') || '',
          baseUrl: getSetting(db, 'ai_openai_base_url') || undefined,
          model: getSetting(db, 'ai_openai_model') || undefined,
          embeddingModel: getSetting(db, 'ai_openai_embedding_model') || undefined,
        },
        ollama: {
          baseUrl: getSetting(db, 'ai_ollama_base_url') || '',
          model: getSetting(db, 'ai_ollama_model') || '',
          embeddingModel: getSetting(db, 'ai_ollama_embedding_model') || undefined,
        },
        custom: {
          baseUrl: getSetting(db, 'ai_custom_base_url') || '',
          apiKey: getSetting(db, 'ai_custom_api_key') || undefined,
          headers: undefined,
          model: getSetting(db, 'ai_custom_model') || undefined,
        },
      },
      vendors: {
        openai: {
          baseUrl: getSetting(db, 'vendors_openai_base_url') || undefined,
          apiKey: getSetting(db, 'vendors_openai_api_key') || undefined,
        },
        homelabAi: {
          baseUrl: getSetting(db, 'vendors_homelab_ai_base_url') || undefined,
        },
      },
      extraction: {
        autoProcess: getSetting(db, 'extraction_auto_process') === 'true' || DEFAULT_SETTINGS.extraction.autoProcess,
        includeEntities: getSetting(db, 'extraction_include_entities') !== 'false',
        includeSentiment: getSetting(db, 'extraction_include_sentiment') !== 'false',
        includeActionItems: getSetting(db, 'extraction_include_action_items') !== 'false',
        includeRelatedEntries: getSetting(db, 'extraction_include_related_entries') === 'true',
        minConfidence: parseFloat(getSetting(db, 'extraction_min_confidence') || String(DEFAULT_SETTINGS.extraction.minConfidence)),
      },
      storage: {
        dataPath: getSetting(db, 'storage_data_path') || DEFAULT_SETTINGS.storage.dataPath,
        backupPath: getSetting(db, 'storage_backup_path') || undefined,
        autoBackup: getSetting(db, 'storage_auto_backup') === 'true' || DEFAULT_SETTINGS.storage.autoBackup,
        maxFileSize: parseInt(getSetting(db, 'storage_max_file_size') || String(DEFAULT_SETTINGS.storage.maxFileSize)),
      },
    };

    return settings;
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

    // Save each setting as a key-value pair
    // Preferences
    setSetting(db, 'preferences_theme', settings.preferences.theme);
    setSetting(db, 'preferences_default_view', settings.preferences.defaultView);
    setSetting(db, 'preferences_weekly_digest', String(settings.preferences.weeklyDigest));
    setSetting(db, 'preferences_digest_day', String(settings.preferences.digestDay));

    // AI
    setSetting(db, 'ai_provider', settings.ai.provider);
    if (settings.ai.openai?.apiKey) setSetting(db, 'ai_openai_api_key', settings.ai.openai.apiKey);
    if (settings.ai.openai?.baseUrl) setSetting(db, 'ai_openai_base_url', settings.ai.openai.baseUrl);
    if (settings.ai.openai?.model) setSetting(db, 'ai_openai_model', settings.ai.openai.model);
    if (settings.ai.openai?.embeddingModel) setSetting(db, 'ai_openai_embedding_model', settings.ai.openai.embeddingModel);

    if (settings.ai.ollama?.baseUrl) setSetting(db, 'ai_ollama_base_url', settings.ai.ollama.baseUrl);
    if (settings.ai.ollama?.model) setSetting(db, 'ai_ollama_model', settings.ai.ollama.model);
    if (settings.ai.ollama?.embeddingModel) setSetting(db, 'ai_ollama_embedding_model', settings.ai.ollama.embeddingModel);

    if (settings.ai.custom?.baseUrl) setSetting(db, 'ai_custom_base_url', settings.ai.custom.baseUrl);
    if (settings.ai.custom?.apiKey) setSetting(db, 'ai_custom_api_key', settings.ai.custom.apiKey);
    if (settings.ai.custom?.model) setSetting(db, 'ai_custom_model', settings.ai.custom.model);

    // Vendors
    if (settings.vendors?.openai?.baseUrl) setSetting(db, 'vendors_openai_base_url', settings.vendors.openai.baseUrl);
    if (settings.vendors?.openai?.apiKey) setSetting(db, 'vendors_openai_api_key', settings.vendors.openai.apiKey);
    if (settings.vendors?.homelabAi?.baseUrl) setSetting(db, 'vendors_homelab_ai_base_url', settings.vendors.homelabAi.baseUrl);

    // Extraction
    setSetting(db, 'extraction_auto_process', String(settings.extraction.autoProcess));
    setSetting(db, 'extraction_include_entities', String(settings.extraction.includeEntities));
    setSetting(db, 'extraction_include_sentiment', String(settings.extraction.includeSentiment));
    setSetting(db, 'extraction_include_action_items', String(settings.extraction.includeActionItems));
    setSetting(db, 'extraction_include_related_entries', String(settings.extraction.includeRelatedEntries));
    setSetting(db, 'extraction_min_confidence', String(settings.extraction.minConfidence));

    // Storage
    setSetting(db, 'storage_data_path', settings.storage.dataPath);
    if (settings.storage.backupPath) setSetting(db, 'storage_backup_path', settings.storage.backupPath);
    setSetting(db, 'storage_auto_backup', String(settings.storage.autoBackup));
    setSetting(db, 'storage_max_file_size', String(settings.storage.maxFileSize));
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

/**
 * Get all settings (alias for loadSettings)
 */
export async function getSettings(): Promise<UserSettings> {
  return loadSettings();
}

/**
 * Get storage configuration only
 */
export async function getStorageConfig() {
  const settings = await loadSettings();
  return settings.storage;
}
