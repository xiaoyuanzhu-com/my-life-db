package models

import "encoding/json"

// ProgressSessionMessage represents progress updates (e.g., hook execution).
type ProgressSessionMessage struct {
	RawJSON
	BaseMessage
	Data            json.RawMessage `json:"data,omitempty"`
	ToolUseID       string          `json:"toolUseID,omitempty"`
	ParentToolUseID string          `json:"parentToolUseID,omitempty"`
}

func (m ProgressSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias ProgressSessionMessage
	return json.Marshal(Alias(m))
}
