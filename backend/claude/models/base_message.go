package models

// BaseMessage contains fields common to all message types.
type BaseMessage struct {
	Type       string  `json:"type"`
	UUID       string  `json:"uuid"`
	ParentUUID *string `json:"parentUuid"`
	Timestamp  string  `json:"timestamp"`
}

// GetType returns the message type.
func (m BaseMessage) GetType() string { return m.Type }

// GetUUID returns the message UUID.
func (m BaseMessage) GetUUID() string { return m.UUID }

// GetTimestamp returns the message timestamp.
func (m BaseMessage) GetTimestamp() string { return m.Timestamp }

// EnvelopeFields contains optional fields that may appear on any message.
type EnvelopeFields struct {
	IsSidechain *bool  `json:"isSidechain,omitempty"`
	UserType    string `json:"userType,omitempty"`
	CWD         string `json:"cwd,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	Version     string `json:"version,omitempty"`
	GitBranch   string `json:"gitBranch,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	Slug        string `json:"slug,omitempty"`
	AgentID     string `json:"agentId,omitempty"`
}
