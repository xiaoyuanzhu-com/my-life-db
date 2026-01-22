package models

import "encoding/json"

// FileHistorySnapshotSessionMessage represents file version tracking.
type FileHistorySnapshotSessionMessage struct {
	RawJSON
	BaseMessage
	MessageID        string          `json:"messageId,omitempty"`
	Snapshot         json.RawMessage `json:"snapshot,omitempty"`
	IsSnapshotUpdate *bool           `json:"isSnapshotUpdate,omitempty"`
}

func (m FileHistorySnapshotSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias FileHistorySnapshotSessionMessage
	return json.Marshal(Alias(m))
}
