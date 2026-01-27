package models

import (
	"encoding/json"
	"strings"
)

// UserSessionMessage represents a user input or tool result message.
type UserSessionMessage struct {
	RawJSON
	BaseMessage
	EnvelopeFields
	Message                 *ClaudeMessage  `json:"message,omitempty"`
	ToolUseResult           json.RawMessage `json:"toolUseResult,omitempty"`
	SourceToolAssistantUUID string          `json:"sourceToolAssistantUUID,omitempty"`
	IsCompactSummary        bool            `json:"isCompactSummary,omitempty"`
}

func (m UserSessionMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias UserSessionMessage
	return json.Marshal(Alias(m))
}

// GetUserPrompt extracts the actual user-typed text from a user message,
// filtering out system-injected tags like <ide_opened_file>, <ide_selection>, <system-reminder>
func (m *UserSessionMessage) GetUserPrompt() string {
	if m.Message == nil || m.Message.Content == nil {
		return ""
	}

	var userTexts []string

	// User messages can be string or []ContentBlock
	if str, ok := m.Message.Content.(string); ok {
		filtered := filterSystemTags(str)
		if filtered != "" {
			userTexts = append(userTexts, filtered)
		}
	} else if blocks, ok := m.Message.Content.([]interface{}); ok {
		for _, block := range blocks {
			if blockMap, ok := block.(map[string]interface{}); ok {
				if blockMap["type"] == "text" {
					if text, ok := blockMap["text"].(string); ok {
						filtered := filterSystemTags(text)
						if filtered != "" {
							userTexts = append(userTexts, filtered)
						}
					}
				}
			}
		}
	}

	return strings.Join(userTexts, "\n")
}

// HasUsefulContent returns true if this user message contains actual user input
// (not just system-injected tags) or a tool use result.
func (m *UserSessionMessage) HasUsefulContent() bool {
	// Tool use results are meaningful content
	if len(m.ToolUseResult) > 0 {
		return true
	}
	// Check if there's actual user-typed content after filtering system tags
	return m.GetUserPrompt() != ""
}

