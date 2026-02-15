package db

import (
	"database/sql"
	"encoding/json"

	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

func GetCollectors() ([]models.CollectorConfig, error) {
	rows, err := GetDB().Query(`
		SELECT id, enabled, config, updated_at FROM collectors ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var collectors []models.CollectorConfig
	for rows.Next() {
		var c models.CollectorConfig
		var enabled int
		var config sql.NullString
		if err := rows.Scan(&c.ID, &enabled, &config, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Enabled = enabled == 1
		if config.Valid {
			raw := json.RawMessage(config.String)
			c.Config = &raw
		}
		collectors = append(collectors, c)
	}
	return collectors, rows.Err()
}

func UpsertCollector(id string, req *models.UpdateCollectorRequest) (*models.CollectorConfig, error) {
	var configStr sql.NullString
	if req.Config != nil {
		configStr = sql.NullString{String: string(*req.Config), Valid: true}
	}

	if req.Enabled != nil && req.Config != nil {
		enabled := 0
		if *req.Enabled {
			enabled = 1
		}
		_, err := GetDB().Exec(`
			INSERT INTO collectors (id, enabled, config, updated_at)
			VALUES (?, ?, ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				enabled = excluded.enabled,
				config = excluded.config,
				updated_at = datetime('now')
		`, id, enabled, configStr)
		if err != nil {
			return nil, err
		}
	} else if req.Enabled != nil {
		enabled := 0
		if *req.Enabled {
			enabled = 1
		}
		_, err := GetDB().Exec(`
			INSERT INTO collectors (id, enabled, updated_at)
			VALUES (?, ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				enabled = excluded.enabled,
				updated_at = datetime('now')
		`, id, enabled)
		if err != nil {
			return nil, err
		}
	} else if req.Config != nil {
		_, err := GetDB().Exec(`
			INSERT INTO collectors (id, config, updated_at)
			VALUES (?, ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				config = excluded.config,
				updated_at = datetime('now')
		`, id, configStr)
		if err != nil {
			return nil, err
		}
	}

	// Return the updated row
	var c models.CollectorConfig
	var enabled int
	var config sql.NullString
	err := GetDB().QueryRow(`
		SELECT id, enabled, config, updated_at FROM collectors WHERE id = ?
	`, id).Scan(&c.ID, &enabled, &config, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	c.Enabled = enabled == 1
	if config.Valid {
		raw := json.RawMessage(config.String)
		c.Config = &raw
	}
	return &c, nil
}
