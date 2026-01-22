package models

import "encoding/json"

// SessionMessageI is implemented by all session message types.
type SessionMessageI interface {
	json.Marshaler
	GetType() string
	GetUUID() string
	GetTimestamp() string
}

// Ensure all types implement SessionMessageI
var (
	_ SessionMessageI = (*UserSessionMessage)(nil)
	_ SessionMessageI = (*AssistantSessionMessage)(nil)
	_ SessionMessageI = (*SystemSessionMessage)(nil)
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
