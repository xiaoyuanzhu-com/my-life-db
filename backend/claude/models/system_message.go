package models

import "encoding/json"

// SystemSessionMessage represents system events (compact_boundary, turn_duration, etc).
// For session initialization (subtype: "init"), use SystemInitMessage instead.
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

// HasUsefulContent returns false - system events are metadata.
func (m *SystemSessionMessage) HasUsefulContent() bool {
	return false
}
