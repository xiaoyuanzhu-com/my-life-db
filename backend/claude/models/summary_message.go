package models

import "encoding/json"

// SummarySessionMessage contains Claude-generated session summary.
type SummarySessionMessage struct {
	RawJSON
	BaseMessage
	Summary  string `json:"summary,omitempty"`
	LeafUUID string `json:"leafUuid,omitempty"`
}

func (m SummarySessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias SummarySessionMessage
	return json.Marshal(Alias(m))
}
