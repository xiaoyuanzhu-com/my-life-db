package models

import "encoding/json"

// SessionMessageI is implemented by all session message types.
type SessionMessageI interface {
	json.Marshaler
	GetType() string
	GetUUID() string
	GetTimestamp() string
	// HasUsefulContent returns true if the message represents meaningful session content.
	// Used to filter out sessions that contain only system-injected or metadata messages.
	HasUsefulContent() bool
}

// Ensure all types implement SessionMessageI
var (
	_ SessionMessageI = (*UserSessionMessage)(nil)
	_ SessionMessageI = (*AssistantSessionMessage)(nil)
	_ SessionMessageI = (*SystemSessionMessage)(nil)
	_ SessionMessageI = (*SystemInitMessage)(nil)
	_ SessionMessageI = (*ResultSessionMessage)(nil)
	_ SessionMessageI = (*ProgressSessionMessage)(nil)
	_ SessionMessageI = (*SummarySessionMessage)(nil)
	_ SessionMessageI = (*CustomTitleSessionMessage)(nil)
	_ SessionMessageI = (*TagSessionMessage)(nil)
	_ SessionMessageI = (*AgentNameSessionMessage)(nil)
	_ SessionMessageI = (*QueueOperationSessionMessage)(nil)
	_ SessionMessageI = (*FileHistorySnapshotSessionMessage)(nil)
	_ SessionMessageI = (*UnknownSessionMessage)(nil)
)
