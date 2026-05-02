package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

func (d *DB) GetCollectors() ([]models.CollectorConfig, error) {
	rows, err := d.conn.Query(`
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

func (d *DB) UpsertCollector(ctx context.Context, id string, req *models.UpdateCollectorRequest) (*models.CollectorConfig, error) {
	var configStr sql.NullString
	if req.Config != nil {
		configStr = sql.NullString{String: string(*req.Config), Valid: true}
	}

	now := time.Now().UnixMilli()

	if err := d.Write(ctx, func(tx *sql.Tx) error {
		if req.Enabled != nil && req.Config != nil {
			enabled := 0
			if *req.Enabled {
				enabled = 1
			}
			_, err := tx.Exec(`
				INSERT INTO collectors (id, enabled, config, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					enabled = excluded.enabled,
					config = excluded.config,
					updated_at = ?
			`, id, enabled, configStr, now, now)
			return err
		} else if req.Enabled != nil {
			enabled := 0
			if *req.Enabled {
				enabled = 1
			}
			_, err := tx.Exec(`
				INSERT INTO collectors (id, enabled, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					enabled = excluded.enabled,
					updated_at = ?
			`, id, enabled, now, now)
			return err
		} else if req.Config != nil {
			_, err := tx.Exec(`
				INSERT INTO collectors (id, config, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					config = excluded.config,
					updated_at = ?
			`, id, configStr, now, now)
			return err
		}
		return nil
	}); err != nil {
		return nil, err
	}

	// Return the updated row
	var c models.CollectorConfig
	var enabled int
	var config sql.NullString
	err := d.conn.QueryRow(`
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
