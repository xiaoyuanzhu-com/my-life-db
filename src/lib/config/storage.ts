// Settings storage and persistence using SQLite (key-value)
import type { UserSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import { getDatabase } from '../db/connection';
import type BetterSqlite3 from 'better-sqlite3';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SettingsStorage' });
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const HOMELAB_AI_DEFAULT_BASE_URL = 'https://haid.home.iloahz.com';
const HOMELAB_AI_DEFAULT_CHROME_CDP_URL = 'http://172.16.2.2:9223/';

function pickSetting(
  dbValue: string | null,
  envValue?: string,
  fallback?: string
): string | undefined {
  if (dbValue !== null && dbValue !== undefined) return dbValue;
  if (envValue !== undefined && envValue !== null) return envValue;
  return fallback;
}

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
        logLevel: ((getSetting(db, 'preferences_log_level') as UserSettings['preferences']['logLevel']) || DEFAULT_SETTINGS.preferences.logLevel || 'info'),
        userEmail: getSetting(db, 'preferences_user_email') || undefined,
      },
      vendors: {
        openai: {
          baseUrl: pickSetting(getSetting(db, 'vendors_openai_base_url'), process.env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL),
          apiKey: pickSetting(getSetting(db, 'vendors_openai_api_key'), process.env.OPENAI_API_KEY),
          model: pickSetting(getSetting(db, 'vendors_openai_model'), process.env.OPENAI_MODEL, OPENAI_DEFAULT_MODEL),
        },
        homelabAi: {
          baseUrl: pickSetting(getSetting(db, 'vendors_homelab_ai_base_url'), process.env.HAID_BASE_URL, HOMELAB_AI_DEFAULT_BASE_URL),
          chromeCdpUrl: pickSetting(getSetting(db, 'vendors_homelab_ai_chrome_cdp_url'), process.env.HAID_CHROME_CDP_URL, HOMELAB_AI_DEFAULT_CHROME_CDP_URL),
        },
        meilisearch: {
          host: pickSetting(getSetting(db, 'vendors_meilisearch_host'), process.env.MEILI_HOST),
        },
        qdrant: {
          host: pickSetting(getSetting(db, 'vendors_qdrant_host'), process.env.QDRANT_URL),
        },
      },
      extraction: {
        autoEnrich: getSetting(db, 'extraction_auto_enrich') === 'true' || DEFAULT_SETTINGS.extraction.autoEnrich,
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
    log.error({ err: error }, 'load settings from db failed');
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
    if (settings.preferences.logLevel) setSetting(db, 'preferences_log_level', settings.preferences.logLevel);
    if (settings.preferences.userEmail) setSetting(db, 'preferences_user_email', settings.preferences.userEmail);

    // Vendors
    if (settings.vendors?.openai?.baseUrl) setSetting(db, 'vendors_openai_base_url', settings.vendors.openai.baseUrl);
    if (settings.vendors?.openai?.apiKey) setSetting(db, 'vendors_openai_api_key', settings.vendors.openai.apiKey);
    if (settings.vendors?.openai && 'model' in settings.vendors.openai) {
      setSetting(db, 'vendors_openai_model', settings.vendors.openai.model ?? '');
    }
    if (settings.vendors?.homelabAi?.baseUrl) setSetting(db, 'vendors_homelab_ai_base_url', settings.vendors.homelabAi.baseUrl);
    if (settings.vendors?.homelabAi?.chromeCdpUrl) {
      setSetting(db, 'vendors_homelab_ai_chrome_cdp_url', settings.vendors.homelabAi.chromeCdpUrl);
    }
    if (settings.vendors?.meilisearch?.host) {
      setSetting(db, 'vendors_meilisearch_host', settings.vendors.meilisearch.host);
    }
    if (settings.vendors?.qdrant?.host) {
      setSetting(db, 'vendors_qdrant_host', settings.vendors.qdrant.host);
    }

    // Extraction
    setSetting(db, 'extraction_auto_enrich', String(settings.extraction.autoEnrich));
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
    log.error({ err: error }, 'save settings to db failed');
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
