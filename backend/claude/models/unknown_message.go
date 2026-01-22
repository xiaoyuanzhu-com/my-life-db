package models

import "encoding/json"

// UnknownSessionMessage is a fallback for message types not yet defined.
type UnknownSessionMessage struct {
	RawJSON
	BaseMessage
}

func (m UnknownSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias UnknownSessionMessage
	return json.Marshal(Alias(m))
}
