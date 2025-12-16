// Settings storage and persistence using SQLite (key-value)
import type { UserSettings } from '~/lib/config/settings';
import { DEFAULT_SETTINGS } from '~/lib/config/settings';
import { getSettingValue, setSettingValue } from '~/.server/db/settings';
import { getLogger } from '~/.server/log/logger';

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
 * Load user settings from database
 */
export async function loadSettings(): Promise<UserSettings> {
  try {
    // Load settings from key-value pairs
    const settings: UserSettings = {
      preferences: {
        theme: (getSettingValue('preferences_theme') as UserSettings['preferences']['theme']) || DEFAULT_SETTINGS.preferences.theme,
        defaultView: (getSettingValue('preferences_default_view') as UserSettings['preferences']['defaultView']) || DEFAULT_SETTINGS.preferences.defaultView,
        weeklyDigest: getSettingValue('preferences_weekly_digest') === 'true' || DEFAULT_SETTINGS.preferences.weeklyDigest,
        digestDay: parseInt(
          getSettingValue('preferences_digest_day') || String(DEFAULT_SETTINGS.preferences.digestDay)
        ) as UserSettings['preferences']['digestDay'],
        logLevel: ((getSettingValue('preferences_log_level') as UserSettings['preferences']['logLevel']) || DEFAULT_SETTINGS.preferences.logLevel || 'info'),
        userEmail: getSettingValue('preferences_user_email') || undefined,
        languages: (() => {
          const stored = getSettingValue('preferences_languages');
          if (!stored) return undefined;
          try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : undefined;
          } catch {
            return undefined;
          }
        })(),
      },
      vendors: {
        openai: {
          baseUrl: pickSetting(getSettingValue('vendors_openai_base_url'), process.env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL),
          apiKey: pickSetting(getSettingValue('vendors_openai_api_key'), process.env.OPENAI_API_KEY),
          model: pickSetting(getSettingValue('vendors_openai_model'), process.env.OPENAI_MODEL, OPENAI_DEFAULT_MODEL),
        },
        homelabAi: {
          baseUrl: pickSetting(getSettingValue('vendors_homelab_ai_base_url'), process.env.HAID_BASE_URL, HOMELAB_AI_DEFAULT_BASE_URL),
          chromeCdpUrl: pickSetting(getSettingValue('vendors_homelab_ai_chrome_cdp_url'), process.env.HAID_CHROME_CDP_URL, HOMELAB_AI_DEFAULT_CHROME_CDP_URL),
        },
        meilisearch: {
          host: pickSetting(getSettingValue('vendors_meilisearch_host'), process.env.MEILI_HOST),
        },
        qdrant: {
          host: pickSetting(getSettingValue('vendors_qdrant_host'), process.env.QDRANT_URL),
        },
      },
      digesters: {
        'url-crawler': getSettingValue('digesters_url_crawler') !== 'false',
        'url-crawl-summary': getSettingValue('digesters_url_crawl_summary') !== 'false',
        'tags': getSettingValue('digesters_tags') !== 'false',
        'search-keyword': getSettingValue('digesters_search_keyword') !== 'false',
        'search-semantic': getSettingValue('digesters_search_semantic') !== 'false',
      },
      extraction: {
        autoEnrich: getSettingValue('extraction_auto_enrich') === 'true' || DEFAULT_SETTINGS.extraction.autoEnrich,
        includeEntities: getSettingValue('extraction_include_entities') !== 'false',
        includeSentiment: getSettingValue('extraction_include_sentiment') !== 'false',
        includeActionItems: getSettingValue('extraction_include_action_items') !== 'false',
        includeRelatedEntries: getSettingValue('extraction_include_related_entries') === 'true',
        minConfidence: parseFloat(getSettingValue('extraction_min_confidence') || String(DEFAULT_SETTINGS.extraction.minConfidence)),
      },
      storage: {
        dataPath: getSettingValue('storage_data_path') || DEFAULT_SETTINGS.storage.dataPath,
        backupPath: getSettingValue('storage_backup_path') || undefined,
        autoBackup: getSettingValue('storage_auto_backup') === 'true' || DEFAULT_SETTINGS.storage.autoBackup,
        maxFileSize: parseInt(getSettingValue('storage_max_file_size') || String(DEFAULT_SETTINGS.storage.maxFileSize)),
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
    // Save each setting as a key-value pair
    // Preferences
    setSettingValue('preferences_theme', settings.preferences.theme);
    setSettingValue('preferences_default_view', settings.preferences.defaultView);
    setSettingValue('preferences_weekly_digest', String(settings.preferences.weeklyDigest));
    setSettingValue('preferences_digest_day', String(settings.preferences.digestDay));
    if (settings.preferences.logLevel) setSettingValue('preferences_log_level', settings.preferences.logLevel);
    if (settings.preferences.userEmail) setSettingValue('preferences_user_email', settings.preferences.userEmail);
    if (settings.preferences.languages) setSettingValue('preferences_languages', JSON.stringify(settings.preferences.languages));

    // Vendors
    if (settings.vendors?.openai?.baseUrl) setSettingValue('vendors_openai_base_url', settings.vendors.openai.baseUrl);
    if (settings.vendors?.openai?.apiKey) setSettingValue('vendors_openai_api_key', settings.vendors.openai.apiKey);
    if (settings.vendors?.openai && 'model' in settings.vendors.openai) {
      setSettingValue('vendors_openai_model', settings.vendors.openai.model ?? '');
    }
    if (settings.vendors?.homelabAi?.baseUrl) setSettingValue('vendors_homelab_ai_base_url', settings.vendors.homelabAi.baseUrl);
    if (settings.vendors?.homelabAi?.chromeCdpUrl) {
      setSettingValue('vendors_homelab_ai_chrome_cdp_url', settings.vendors.homelabAi.chromeCdpUrl);
    }
    if (settings.vendors?.meilisearch?.host) {
      setSettingValue('vendors_meilisearch_host', settings.vendors.meilisearch.host);
    }
    if (settings.vendors?.qdrant?.host) {
      setSettingValue('vendors_qdrant_host', settings.vendors.qdrant.host);
    }

    // Digesters
    if (settings.digesters) {
      setSettingValue('digesters_url_crawler', String(settings.digesters['url-crawler'] ?? true));
      setSettingValue('digesters_url_crawl_summary', String(settings.digesters['url-crawl-summary'] ?? true));
      setSettingValue('digesters_tags', String(settings.digesters['tags'] ?? true));
      setSettingValue('digesters_search_keyword', String(settings.digesters['search-keyword'] ?? true));
      setSettingValue('digesters_search_semantic', String(settings.digesters['search-semantic'] ?? true));
    }

    // Extraction
    setSettingValue('extraction_auto_enrich', String(settings.extraction.autoEnrich));
    setSettingValue('extraction_include_entities', String(settings.extraction.includeEntities));
    setSettingValue('extraction_include_sentiment', String(settings.extraction.includeSentiment));
    setSettingValue('extraction_include_action_items', String(settings.extraction.includeActionItems));
    setSettingValue('extraction_include_related_entries', String(settings.extraction.includeRelatedEntries));
    setSettingValue('extraction_min_confidence', String(settings.extraction.minConfidence));

    // Storage
    setSettingValue('storage_data_path', settings.storage.dataPath);
    if (settings.storage.backupPath) setSettingValue('storage_backup_path', settings.storage.backupPath);
    setSettingValue('storage_auto_backup', String(settings.storage.autoBackup));
    setSettingValue('storage_max_file_size', String(settings.storage.maxFileSize));
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
