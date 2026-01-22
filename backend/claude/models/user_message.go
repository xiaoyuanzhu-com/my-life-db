package models

import "encoding/json"

// UserSessionMessage represents a user input or tool result message.
type UserSessionMessage struct {
	RawJSON
	BaseMessage
	EnvelopeFields
	Message                 *ClaudeMessage  `json:"message,omitempty"`
	ToolUseResult           json.RawMessage `json:"toolUseResult,omitempty"`
	SourceToolAssistantUUID string          `json:"sourceToolAssistantUUID,omitempty"`
}

func (m UserSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias UserSessionMessage
	return json.Marshal(Alias(m))
}
