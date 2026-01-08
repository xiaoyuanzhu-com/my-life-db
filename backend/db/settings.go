package db

import (
	"database/sql"
	"encoding/json"
	"os"
	"strconv"

	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

// Default settings
var defaultSettings = map[string]string{
	"openai_model":        "gpt-4o-mini",
	"openai_base_url":     "",
	"haid_base_url":       "",
	"meili_host":          "",
	"qdrant_host":         "",
	"digest_auto_process": "true",
}

// GetSetting retrieves a setting by key
func GetSetting(key string) (string, error) {
	var value string
	err := GetDB().QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value)
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
func SetSetting(key, value string) error {
	_, err := GetDB().Exec(`
		INSERT INTO settings (key, value, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = CURRENT_TIMESTAMP
	`, key, value)
	return err
}

// DeleteSetting removes a setting
func DeleteSetting(key string) error {
	_, err := GetDB().Exec("DELETE FROM settings WHERE key = ?", key)
	return err
}

// GetAllSettings retrieves all settings
func GetAllSettings() (map[string]string, error) {
	// Start with defaults
	settings := make(map[string]string)
	for k, v := range defaultSettings {
		settings[k] = v
	}

	// Override with stored settings
	rows, err := GetDB().Query("SELECT key, value FROM settings")
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
func UpdateSettings(settings map[string]string) error {
	return Transaction(func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT INTO settings (key, value, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = CURRENT_TIMESTAMP
		`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for key, value := range settings {
			if _, err := stmt.Exec(key, value); err != nil {
				return err
			}
		}

		return nil
	})
}

// ResetSettings removes all non-default settings
func ResetSettings() error {
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
	_, err := GetDB().Exec(query, args...)
	return err
}

// GetSettingJSON retrieves a setting and unmarshals it from JSON
func GetSettingJSON(key string, v interface{}) error {
	value, err := GetSetting(key)
	if err != nil {
		return err
	}
	if value == "" {
		return nil
	}
	return json.Unmarshal([]byte(value), v)
}

// SetSettingJSON marshals a value to JSON and stores it
func SetSettingJSON(key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return SetSetting(key, string(data))
}

// Helper function to pick setting value: DB > Env > Default
func pickSetting(dbKey string, envKey string, defaultValue string) string {
	// First try DB
	if val, err := GetSetting(dbKey); err == nil && val != "" {
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

// LoadUserSettings loads settings from DB and converts to structured UserSettings
func LoadUserSettings() (*models.UserSettings, error) {
	// Build preferences
	preferences := models.Preferences{
		Theme:        pickSetting("preferences_theme", "", "auto"),
		DefaultView:  pickSetting("preferences_default_view", "", "home"),
		WeeklyDigest: pickSetting("preferences_weekly_digest", "", "false") == "true",
		DigestDay:    0,
		LogLevel:     pickSetting("preferences_log_level", "", "info"),
	}

	// Parse digest day
	if dayStr := pickSetting("preferences_digest_day", "", "0"); dayStr != "" {
		if day, err := strconv.Atoi(dayStr); err == nil {
			preferences.DigestDay = day
		}
	}

	// Optional preference fields
	if email := pickSetting("preferences_user_email", "", ""); email != "" {
		preferences.UserEmail = email
	}

	// Parse languages array
	if langStr := pickSetting("preferences_languages", "", ""); langStr != "" {
		var langs []string
		if err := json.Unmarshal([]byte(langStr), &langs); err == nil && len(langs) > 0 {
			preferences.Languages = langs
		}
	}

	// Build vendors
	vendors := &models.Vendors{
		OpenAI: &models.OpenAI{
			BaseURL: pickSetting("vendors_openai_base_url", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
			APIKey:  pickSetting("vendors_openai_api_key", "OPENAI_API_KEY", ""),
			Model:   pickSetting("vendors_openai_model", "OPENAI_MODEL", "gpt-4o-mini"),
		},
		HomelabAI: &models.HomelabAI{
			BaseURL:      pickSetting("vendors_homelab_ai_base_url", "HAID_BASE_URL", "https://haid.home.iloahz.com"),
			ChromeCdpURL: pickSetting("vendors_homelab_ai_chrome_cdp_url", "HAID_CHROME_CDP_URL", "http://172.16.2.2:9223/"),
		},
		Meilisearch: &models.Meilisearch{
			Host: pickSetting("vendors_meilisearch_host", "MEILI_HOST", ""),
		},
		Qdrant: &models.Qdrant{
			Host: pickSetting("vendors_qdrant_host", "QDRANT_URL", ""),
		},
	}

	// Build digesters
	digesters := map[string]bool{
		"url-crawler":       pickSetting("digesters_url_crawler", "", "true") != "false",
		"url-crawl-summary": pickSetting("digesters_url_crawl_summary", "", "true") != "false",
		"tags":              pickSetting("digesters_tags", "", "true") != "false",
		"search-keyword":    pickSetting("digesters_search_keyword", "", "true") != "false",
		"search-semantic":   pickSetting("digesters_search_semantic", "", "true") != "false",
	}

	// Build extraction
	extraction := models.Extraction{
		AutoEnrich:            pickSetting("extraction_auto_enrich", "", "false") == "true",
		IncludeEntities:       pickSetting("extraction_include_entities", "", "true") != "false",
		IncludeSentiment:      pickSetting("extraction_include_sentiment", "", "true") != "false",
		IncludeActionItems:    pickSetting("extraction_include_action_items", "", "true") != "false",
		IncludeRelatedEntries: pickSetting("extraction_include_related_entries", "", "false") == "true",
		MinConfidence:         0.5,
	}

	// Parse min confidence
	if confStr := pickSetting("extraction_min_confidence", "", "0.5"); confStr != "" {
		if conf, err := strconv.ParseFloat(confStr, 64); err == nil {
			extraction.MinConfidence = conf
		}
	}

	// Build storage
	storage := models.Storage{
		DataPath:    pickSetting("storage_data_path", "MY_DATA_DIR", "./data"),
		AutoBackup:  pickSetting("storage_auto_backup", "", "false") == "true",
		MaxFileSize: 50,
	}

	// Parse max file size
	if sizeStr := pickSetting("storage_max_file_size", "", "50"); sizeStr != "" {
		if size, err := strconv.Atoi(sizeStr); err == nil {
			storage.MaxFileSize = size
		}
	}

	// Optional storage fields
	if backupPath := pickSetting("storage_backup_path", "", ""); backupPath != "" {
		storage.BackupPath = backupPath
	}

	return &models.UserSettings{
		Preferences: preferences,
		Vendors:     vendors,
		Digesters:   digesters,
		Extraction:  extraction,
		Storage:     storage,
	}, nil
}

// SaveUserSettings converts UserSettings to flat key-value pairs and saves to DB
func SaveUserSettings(settings *models.UserSettings) error {
	updates := make(map[string]string)

	// Preferences
	updates["preferences_theme"] = settings.Preferences.Theme
	updates["preferences_default_view"] = settings.Preferences.DefaultView
	updates["preferences_weekly_digest"] = strconv.FormatBool(settings.Preferences.WeeklyDigest)
	updates["preferences_digest_day"] = strconv.Itoa(settings.Preferences.DigestDay)
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
		if settings.Vendors.HomelabAI != nil {
			if settings.Vendors.HomelabAI.BaseURL != "" {
				updates["vendors_homelab_ai_base_url"] = settings.Vendors.HomelabAI.BaseURL
			}
			if settings.Vendors.HomelabAI.ChromeCdpURL != "" {
				updates["vendors_homelab_ai_chrome_cdp_url"] = settings.Vendors.HomelabAI.ChromeCdpURL
			}
		}
		if settings.Vendors.Meilisearch != nil && settings.Vendors.Meilisearch.Host != "" {
			updates["vendors_meilisearch_host"] = settings.Vendors.Meilisearch.Host
		}
		if settings.Vendors.Qdrant != nil && settings.Vendors.Qdrant.Host != "" {
			updates["vendors_qdrant_host"] = settings.Vendors.Qdrant.Host
		}
	}

	// Digesters
	if settings.Digesters != nil {
		for key, value := range settings.Digesters {
			updates["digesters_"+key] = strconv.FormatBool(value)
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

	return UpdateSettings(updates)
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
