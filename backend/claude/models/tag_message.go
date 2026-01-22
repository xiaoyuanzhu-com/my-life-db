package models

import "encoding/json"

// TagSessionMessage contains user-assigned session tag.
type TagSessionMessage struct {
	RawJSON
	BaseMessage
	Tag string `json:"tag,omitempty"`
}

func (m TagSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias TagSessionMessage
	return json.Marshal(Alias(m))
}
