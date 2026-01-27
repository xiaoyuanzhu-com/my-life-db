package models

import "encoding/json"

// AssistantSessionMessage represents Claude's response with text and/or tool calls.
type AssistantSessionMessage struct {
	RawJSON
	BaseMessage
	EnvelopeFields
	Message *ClaudeMessage `json:"message,omitempty"`
}

func (m AssistantSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias AssistantSessionMessage
	return json.Marshal(Alias(m))
}

// HasUsefulContent returns true - assistant messages indicate real conversation.
func (m *AssistantSessionMessage) HasUsefulContent() bool {
	return true
}
