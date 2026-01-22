package models

import "strings"

// SessionMessage is a typed wrapper for internal use (title extraction, etc.)
// For API responses, use ReadSessionHistoryRaw which returns SessionMessageI.
type SessionMessage struct {
	Type       string         `json:"type"`
	UUID       string         `json:"uuid"`
	ParentUUID *string        `json:"parentUuid"`
	Timestamp  string         `json:"timestamp"`
	Message    *ClaudeMessage `json:"message"`

	IsSidechain             *bool       `json:"isSidechain,omitempty"`
	UserType                string      `json:"userType,omitempty"`
	CWD                     string      `json:"cwd,omitempty"`
	SessionID               string      `json:"sessionId,omitempty"`
	Version                 string      `json:"version,omitempty"`
	GitBranch               string      `json:"gitBranch,omitempty"`
	RequestID               string      `json:"requestId,omitempty"`
	ToolUseResult           interface{} `json:"toolUseResult,omitempty"`
	SourceToolAssistantUUID string      `json:"sourceToolAssistantUUID,omitempty"`
}

// GetTextContent extracts text content from a message
// For user messages: returns the string content directly
// For assistant messages: extracts and joins text from all text blocks
func (m *SessionMessage) GetTextContent() string {
	if m.Message == nil || m.Message.Content == nil {
		return ""
	}

	// User messages have string content
	if str, ok := m.Message.Content.(string); ok {
		return str
	}

	// Assistant messages have []ContentBlock (comes as []interface{})
	if blocks, ok := m.Message.Content.([]interface{}); ok {
		var texts []string
		for _, block := range blocks {
			if blockMap, ok := block.(map[string]interface{}); ok {
				if blockMap["type"] == "text" {
					if text, ok := blockMap["text"].(string); ok {
						texts = append(texts, text)
					}
				}
			}
		}
		return strings.Join(texts, "\n")
	}

	return ""
}

// GetUserPrompt extracts the actual user-typed text from a user message,
// filtering out system-injected tags like <ide_opened_file>, <ide_selection>, <system-reminder>
func (m *SessionMessage) GetUserPrompt() string {
	if m.Message == nil || m.Message.Content == nil || m.Type != "user" {
		return ""
	}

	var userTexts []string

	// User messages can be string or []ContentBlock
	if str, ok := m.Message.Content.(string); ok {
		// Single string content - filter out system tags
		filtered := filterSystemTags(str)
		if filtered != "" {
			userTexts = append(userTexts, filtered)
		}
	} else if blocks, ok := m.Message.Content.([]interface{}); ok {
		// Array of content blocks
		for _, block := range blocks {
			if blockMap, ok := block.(map[string]interface{}); ok {
				if blockMap["type"] == "text" {
					if text, ok := blockMap["text"].(string); ok {
						// Filter out system-injected tags
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

// filterSystemTags removes system-injected XML tags from text
// Returns empty string if text is only system tags
func filterSystemTags(text string) string {
	// Check if text starts with a system tag
	if strings.HasPrefix(text, "<ide_") ||
		strings.HasPrefix(text, "<system-reminder>") {
		return ""
	}
	return strings.TrimSpace(text)
}

// GetToolCalls extracts tool use blocks from an assistant message
func (m *SessionMessage) GetToolCalls() []ContentBlock {
	if m.Message == nil || m.Message.Content == nil {
		return nil
	}

	// Only assistant messages have tool calls
	if m.Type != "assistant" {
		return nil
	}

	blocks, ok := m.Message.Content.([]interface{})
	if !ok {
		return nil
	}

	var toolCalls []ContentBlock
	for _, block := range blocks {
		blockMap, ok := block.(map[string]interface{})
		if !ok {
			continue
		}

		if blockMap["type"] == "tool_use" {
			toolCall := ContentBlock{
				Type: "tool_use",
			}
			if id, ok := blockMap["id"].(string); ok {
				toolCall.ID = id
			}
			if name, ok := blockMap["name"].(string); ok {
				toolCall.Name = name
			}
			if input, ok := blockMap["input"].(map[string]interface{}); ok {
				toolCall.Input = input
			}
			toolCalls = append(toolCalls, toolCall)
		}
	}

	return toolCalls
}
