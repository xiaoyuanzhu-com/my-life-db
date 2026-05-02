package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strconv"

	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

// Default settings
var defaultSettings = map[string]string{
	"openai_model":    "gpt-4o-mini",
	"openai_base_url": "",
	"qdrant_host":     "",
}

// GetSetting retrieves a setting by key
func (d *DB) GetSetting(key string) (string, error) {
	var value string
	err := d.conn.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		if defaultValue, ok := defaultSettings[key]; ok {
			return defaultValue, nil
		}
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return value, nil
}

// SetSetting updates or creates a setting
func (d *DB) SetSetting(ctx context.Context, key, value string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			INSERT INTO settings (key, value, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at
		`, key, value, NowMs())
		return err
	})
}

// DeleteSetting removes a setting
func (d *DB) DeleteSetting(ctx context.Context, key string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM settings WHERE key = ?", key)
		return err
	})
}

// GetAllSettings retrieves all settings
func (d *DB) GetAllSettings() (map[string]string, error) {
	// Start with defaults
	settings := make(map[string]string)
	for k, v := range defaultSettings {
		settings[k] = v
	}

	// Override with stored settings
	rows, err := d.conn.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		settings[key] = value
	}

	return settings, nil
}

// UpdateSettings updates multiple settings at once
func (d *DB) UpdateSettings(ctx context.Context, settings map[string]string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT INTO settings (key, value, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at
		`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		now := NowMs()
		for key, value := range settings {
			if _, err := stmt.Exec(key, value, now); err != nil {
				return err
			}
		}

		return nil
	})
}

// ResetSettings removes all non-default settings
func (d *DB) ResetSettings(ctx context.Context) error {
	// Keep only default settings
	keys := make([]string, 0, len(defaultSettings))
	for k := range defaultSettings {
		keys = append(keys, k)
	}

	// Build query with placeholders
	placeholders := ""
	args := make([]interface{}, len(keys))
	for i, k := range keys {
		if i > 0 {
			placeholders += ", "
		}
		placeholders += "?"
		args[i] = k
	}

	query := "DELETE FROM settings WHERE key NOT IN (" + placeholders + ")"
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query, args...)
		return err
	})
}

// GetSettingJSON retrieves a setting and unmarshals it from JSON
func (d *DB) GetSettingJSON(key string, v interface{}) error {
	value, err := d.GetSetting(key)
	if err != nil {
		return err
	}
	if value == "" {
		return nil
	}
	return json.Unmarshal([]byte(value), v)
}

// SetSettingJSON marshals a value to JSON and stores it
func (d *DB) SetSettingJSON(ctx context.Context, key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return d.SetSetting(ctx, key, string(data))
}

// LoadUserSettings loads settings from DB and converts to structured UserSettings
func (d *DB) LoadUserSettings() (*models.UserSettings, error) {
	// Load all settings once to avoid N+1 queries
	allSettings, err := d.GetAllSettings()
	if err != nil {
		return nil, err
	}

	// Helper to pick from pre-loaded settings map
	pickFromMap := func(dbKey, envKey, defaultValue string) string {
		// First try the pre-loaded settings map
		if val, ok := allSettings[dbKey]; ok && val != "" {
			return val
		}
		// Then try env
		if envKey != "" {
			if envVal := os.Getenv(envKey); envVal != "" {
				return envVal
			}
		}
		// Finally use default
		return defaultValue
	}

	// Build preferences
	preferences := models.Preferences{
		Theme:       pickFromMap("preferences_theme", "", "auto"),
		DefaultView: pickFromMap("preferences_default_view", "", "home"),
		LogLevel:    pickFromMap("preferences_log_level", "", "info"),
	}

	// Optional preference fields
	if email := pickFromMap("preferences_user_email", "", ""); email != "" {
		preferences.UserEmail = email
	}

	// Parse languages array
	if langStr := pickFromMap("preferences_languages", "", ""); langStr != "" {
		var langs []string
		if err := json.Unmarshal([]byte(langStr), &langs); err == nil && len(langs) > 0 {
			preferences.Languages = langs
		}
	}

	// Parse UI language (singular). Empty/missing → leave nil so the
	// frontend treats it as "system default".
	if uiLang := pickFromMap("preferences_language", "", ""); uiLang != "" {
		preferences.Language = &uiLang
	}

	// Build vendors
	vendors := &models.Vendors{
		OpenAI: &models.OpenAI{
			BaseURL: pickFromMap("vendors_openai_base_url", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
			APIKey:  pickFromMap("vendors_openai_api_key", "OPENAI_API_KEY", ""),
			Model:   pickFromMap("vendors_openai_model", "OPENAI_MODEL", "gpt-4o-mini"),
		},
		Aliyun: &models.Aliyun{
			APIKey:             pickFromMap("vendors_aliyun_api_key", "DASHSCOPE_API_KEY", ""),
			Region:             pickFromMap("vendors_aliyun_region", "ALIYUN_REGION", "beijing"),
			OSSAccessKeyID:     pickFromMap("vendors_aliyun_oss_access_key_id", "OSS_ACCESS_KEY_ID", ""),
			OSSAccessKeySecret: pickFromMap("vendors_aliyun_oss_access_key_secret", "OSS_ACCESS_KEY_SECRET", ""),
			OSSRegion:          pickFromMap("vendors_aliyun_oss_region", "OSS_REGION", "oss-cn-beijing"),
			OSSBucket:          pickFromMap("vendors_aliyun_oss_bucket", "OSS_BUCKET", ""),
		},
	}

	// Build extraction
	extraction := models.Extraction{
		AutoEnrich:            pickFromMap("extraction_auto_enrich", "", "false") == "true",
		IncludeEntities:       pickFromMap("extraction_include_entities", "", "true") != "false",
		IncludeSentiment:      pickFromMap("extraction_include_sentiment", "", "true") != "false",
		IncludeActionItems:    pickFromMap("extraction_include_action_items", "", "true") != "false",
		IncludeRelatedEntries: pickFromMap("extraction_include_related_entries", "", "false") == "true",
		MinConfidence:         0.5,
	}

	// Parse min confidence
	if confStr := pickFromMap("extraction_min_confidence", "", "0.5"); confStr != "" {
		if conf, err := strconv.ParseFloat(confStr, 64); err == nil {
			extraction.MinConfidence = conf
		}
	}

	// Build storage
	storage := models.Storage{
		DataPath:    pickFromMap("storage_data_path", "MY_DATA_DIR", "./data"),
		AutoBackup:  pickFromMap("storage_auto_backup", "", "false") == "true",
		MaxFileSize: 50,
	}

	// Parse max file size
	if sizeStr := pickFromMap("storage_max_file_size", "", "50"); sizeStr != "" {
		if size, err := strconv.Atoi(sizeStr); err == nil {
			storage.MaxFileSize = size
		}
	}

	// Optional storage fields
	if backupPath := pickFromMap("storage_backup_path", "", ""); backupPath != "" {
		storage.BackupPath = backupPath
	}

	return &models.UserSettings{
		Preferences: preferences,
		Vendors:     vendors,
		Extraction:  extraction,
		Storage:     storage,
	}, nil
}

// SaveUserSettings converts UserSettings to flat key-value pairs and saves to DB
func (d *DB) SaveUserSettings(ctx context.Context, settings *models.UserSettings) error {
	updates := make(map[string]string)

	// Preferences
	updates["preferences_theme"] = settings.Preferences.Theme
	updates["preferences_default_view"] = settings.Preferences.DefaultView
	if settings.Preferences.LogLevel != "" {
		updates["preferences_log_level"] = settings.Preferences.LogLevel
	}
	if settings.Preferences.UserEmail != "" {
		updates["preferences_user_email"] = settings.Preferences.UserEmail
	}
	if len(settings.Preferences.Languages) > 0 {
		if langJSON, err := json.Marshal(settings.Preferences.Languages); err == nil {
			updates["preferences_languages"] = string(langJSON)
		}
	}
	// nil → leave existing row untouched (no change requested).
	// non-nil empty → explicit clear, drop the row.
	// non-nil non-empty → upsert with the new value.
	if settings.Preferences.Language != nil {
		if *settings.Preferences.Language == "" {
			if err := d.DeleteSetting(ctx, "preferences_language"); err != nil {
				return err
			}
		} else {
			updates["preferences_language"] = *settings.Preferences.Language
		}
	}

	// Vendors
	if settings.Vendors != nil {
		if settings.Vendors.OpenAI != nil {
			if settings.Vendors.OpenAI.BaseURL != "" {
				updates["vendors_openai_base_url"] = settings.Vendors.OpenAI.BaseURL
			}
			if settings.Vendors.OpenAI.APIKey != "" {
				updates["vendors_openai_api_key"] = settings.Vendors.OpenAI.APIKey
			}
			if settings.Vendors.OpenAI.Model != "" {
				updates["vendors_openai_model"] = settings.Vendors.OpenAI.Model
			}
		}
		if settings.Vendors.Aliyun != nil {
			if settings.Vendors.Aliyun.APIKey != "" {
				updates["vendors_aliyun_api_key"] = settings.Vendors.Aliyun.APIKey
			}
			if settings.Vendors.Aliyun.Region != "" {
				updates["vendors_aliyun_region"] = settings.Vendors.Aliyun.Region
			}
			if settings.Vendors.Aliyun.OSSAccessKeyID != "" {
				updates["vendors_aliyun_oss_access_key_id"] = settings.Vendors.Aliyun.OSSAccessKeyID
			}
			if settings.Vendors.Aliyun.OSSAccessKeySecret != "" {
				updates["vendors_aliyun_oss_access_key_secret"] = settings.Vendors.Aliyun.OSSAccessKeySecret
			}
			if settings.Vendors.Aliyun.OSSRegion != "" {
				updates["vendors_aliyun_oss_region"] = settings.Vendors.Aliyun.OSSRegion
			}
			if settings.Vendors.Aliyun.OSSBucket != "" {
				updates["vendors_aliyun_oss_bucket"] = settings.Vendors.Aliyun.OSSBucket
			}
		}
	}

	// Extraction
	updates["extraction_auto_enrich"] = strconv.FormatBool(settings.Extraction.AutoEnrich)
	updates["extraction_include_entities"] = strconv.FormatBool(settings.Extraction.IncludeEntities)
	updates["extraction_include_sentiment"] = strconv.FormatBool(settings.Extraction.IncludeSentiment)
	updates["extraction_include_action_items"] = strconv.FormatBool(settings.Extraction.IncludeActionItems)
	updates["extraction_include_related_entries"] = strconv.FormatBool(settings.Extraction.IncludeRelatedEntries)
	updates["extraction_min_confidence"] = strconv.FormatFloat(settings.Extraction.MinConfidence, 'f', -1, 64)

	// Storage
	updates["storage_data_path"] = settings.Storage.DataPath
	if settings.Storage.BackupPath != "" {
		updates["storage_backup_path"] = settings.Storage.BackupPath
	}
	updates["storage_auto_backup"] = strconv.FormatBool(settings.Storage.AutoBackup)
	updates["storage_max_file_size"] = strconv.Itoa(settings.Storage.MaxFileSize)

	return d.UpdateSettings(ctx, updates)
}

// SanitizeSettings masks sensitive data before sending to client
func SanitizeSettings(settings *models.UserSettings) *models.UserSettings {
	// Make a copy to avoid modifying the original
	sanitized := *settings

	// Deep copy vendors to modify API keys
	if settings.Vendors != nil {
		vendorsCopy := *settings.Vendors
		sanitized.Vendors = &vendorsCopy

		if settings.Vendors.OpenAI != nil {
			openaiCopy := *settings.Vendors.OpenAI
			sanitized.Vendors.OpenAI = &openaiCopy

			// Mask API key if present
			if openaiCopy.APIKey != "" {
				sanitized.Vendors.OpenAI.APIKey = maskAPIKey(openaiCopy.APIKey)
			}
		}

		if settings.Vendors.Aliyun != nil {
			aliyunCopy := *settings.Vendors.Aliyun
			sanitized.Vendors.Aliyun = &aliyunCopy

			// Mask API keys if present
			if aliyunCopy.APIKey != "" {
				sanitized.Vendors.Aliyun.APIKey = maskAPIKey(aliyunCopy.APIKey)
			}
			if aliyunCopy.OSSAccessKeyID != "" {
				sanitized.Vendors.Aliyun.OSSAccessKeyID = maskAPIKey(aliyunCopy.OSSAccessKeyID)
			}
			if aliyunCopy.OSSAccessKeySecret != "" {
				sanitized.Vendors.Aliyun.OSSAccessKeySecret = maskAPIKey(aliyunCopy.OSSAccessKeySecret)
			}
		}
	}

	return &sanitized
}

// maskAPIKey replaces an API key with asterisks of the same length
func maskAPIKey(apiKey string) string {
	if apiKey == "" {
		return ""
	}
	masked := ""
	for range apiKey {
		masked += "*"
	}
	return masked
}
