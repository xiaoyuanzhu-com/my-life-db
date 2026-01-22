package models

import "encoding/json"

// ResultSessionMessage marks the end of Claude's turn with stats and summary.
type ResultSessionMessage struct {
	RawJSON
	BaseMessage
	Subtype       string          `json:"subtype,omitempty"` // "success" or "error"
	IsError       *bool           `json:"is_error,omitempty"`
	Result        string          `json:"result,omitempty"`
	NumTurns      int             `json:"num_turns,omitempty"`
	DurationMs    int64           `json:"duration_ms,omitempty"`
	DurationAPIMs int64           `json:"duration_api_ms,omitempty"`
	TotalCostUSD  float64         `json:"total_cost_usd,omitempty"`
	Usage         json.RawMessage `json:"usage,omitempty"`
	ModelUsage    json.RawMessage `json:"modelUsage,omitempty"`
}

func (m ResultSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias ResultSessionMessage
	return json.Marshal(Alias(m))
}
