package db

import (
	"database/sql"
	"encoding/json"
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
