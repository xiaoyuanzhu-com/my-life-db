package models

import "encoding/json"

// ProgressSessionMessage represents progress updates (e.g., hook execution, bash progress).
type ProgressSessionMessage struct {
	RawJSON
	BaseMessage
	Data            json.RawMessage `json:"data,omitempty"`
	ToolUseID       string          `json:"toolUseID,omitempty"`
	ParentToolUseID string          `json:"parentToolUseID,omitempty"`
}

// ProgressDataType identifies the type of progress data.
type ProgressDataType string

const (
	ProgressDataTypeHook ProgressDataType = "hook_progress"
	ProgressDataTypeBash ProgressDataType = "bash_progress"
)

// ProgressDataBase contains the common type field for progress data.
type ProgressDataBase struct {
	Type ProgressDataType `json:"type"`
}

// HookProgressData represents hook execution progress.
type HookProgressData struct {
	Type      ProgressDataType `json:"type"` // "hook_progress"
	HookEvent string           `json:"hookEvent,omitempty"`
	HookName  string           `json:"hookName,omitempty"`
	Command   string           `json:"command,omitempty"`
}

// BashProgressData represents bash command execution progress.
type BashProgressData struct {
	Type               ProgressDataType `json:"type"` // "bash_progress"
	Output             string           `json:"output"`
	FullOutput         string           `json:"fullOutput"`
	ElapsedTimeSeconds int              `json:"elapsedTimeSeconds"`
	TotalLines         int              `json:"totalLines"`
}

func (m ProgressSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias ProgressSessionMessage
	return json.Marshal(Alias(m))
}

// GetProgressDataType returns the type of progress data without full parsing.
func (m ProgressSessionMessage) GetProgressDataType() (ProgressDataType, error) {
	if len(m.Data) == 0 {
		return "", nil
	}
	var base ProgressDataBase
	if err := json.Unmarshal(m.Data, &base); err != nil {
		return "", err
	}
	return base.Type, nil
}

// GetBashProgressData parses and returns BashProgressData if the data type is bash_progress.
func (m ProgressSessionMessage) GetBashProgressData() (*BashProgressData, error) {
	if len(m.Data) == 0 {
		return nil, nil
	}
	var data BashProgressData
	if err := json.Unmarshal(m.Data, &data); err != nil {
		return nil, err
	}
	if data.Type != ProgressDataTypeBash {
		return nil, nil
	}
	return &data, nil
}

// GetHookProgressData parses and returns HookProgressData if the data type is hook_progress.
func (m ProgressSessionMessage) GetHookProgressData() (*HookProgressData, error) {
	if len(m.Data) == 0 {
		return nil, nil
	}
	var data HookProgressData
	if err := json.Unmarshal(m.Data, &data); err != nil {
		return nil, err
	}
	if data.Type != ProgressDataTypeHook {
		return nil, nil
	}
	return &data, nil
}

// HasUsefulContent returns false - progress messages are metadata.
func (m *ProgressSessionMessage) HasUsefulContent() bool {
	return false
}
