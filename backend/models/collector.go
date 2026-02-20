package models

import "encoding/json"

type CollectorConfig struct {
	ID        string           `json:"id"`
	Enabled   bool             `json:"enabled"`
	Config    *json.RawMessage `json:"config"`
	UpdatedAt int64            `json:"updatedAt,omitempty"`
}

type UpdateCollectorRequest struct {
	Enabled *bool            `json:"enabled,omitempty"`
	Config  *json.RawMessage `json:"config,omitempty"`
}
