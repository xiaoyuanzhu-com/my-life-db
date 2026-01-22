package models

import "encoding/json"

// SystemSessionMessage represents system events (compaction, init, turn_duration, etc).
type SystemSessionMessage struct {
	RawJSON
	BaseMessage
	Subtype           string          `json:"subtype,omitempty"`
	Content           string          `json:"content,omitempty"`
	Level             string          `json:"level,omitempty"`
	IsMeta            *bool           `json:"isMeta,omitempty"`
	DurationMs        int64           `json:"durationMs,omitempty"`
	CompactMetadata   json.RawMessage `json:"compactMetadata,omitempty"`
	LogicalParentUUID *string         `json:"logicalParentUuid,omitempty"`
}

func (m SystemSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias SystemSessionMessage
	return json.Marshal(Alias(m))
}
