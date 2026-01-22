package models

import "encoding/json"

// CustomTitleSessionMessage contains user-set custom title.
type CustomTitleSessionMessage struct {
	RawJSON
	BaseMessage
	CustomTitle string `json:"customTitle,omitempty"`
}

func (m CustomTitleSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias CustomTitleSessionMessage
	return json.Marshal(Alias(m))
}
