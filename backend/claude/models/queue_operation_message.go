package models

import "encoding/json"

// QueueOperationSessionMessage represents internal queue management.
type QueueOperationSessionMessage struct {
	RawJSON
	BaseMessage
	Operation string `json:"operation,omitempty"` // "enqueue", "dequeue"
}

func (m QueueOperationSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias QueueOperationSessionMessage
	return json.Marshal(Alias(m))
}
