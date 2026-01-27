package models

import "encoding/json"

// AgentNameSessionMessage contains subagent name assignment.
type AgentNameSessionMessage struct {
	RawJSON
	BaseMessage
	AgentName  string `json:"agentName,omitempty"`
	AgentColor string `json:"agentColor,omitempty"`
}

func (m AgentNameSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias AgentNameSessionMessage
	return json.Marshal(Alias(m))
}

// HasUsefulContent returns false - agent name messages are metadata.
func (m *AgentNameSessionMessage) HasUsefulContent() bool {
	return false
}
