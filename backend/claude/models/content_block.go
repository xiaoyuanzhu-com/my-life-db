package models

// ContentBlock represents a content block in a Claude message.
// Messages can contain different types of blocks:
// - "text": Text content from the assistant
// - "thinking": Extended thinking from the assistant (Opus 4.5+)
// - "tool_use": A tool invocation (e.g., Bash, Read, Edit)
// - "tool_result": The result of a tool execution
type ContentBlock struct {
	Type      string                 `json:"type"`                  // "text", "thinking", "tool_use", "tool_result"
	Text      string                 `json:"text,omitempty"`        // For text blocks
	Thinking  string                 `json:"thinking,omitempty"`    // For thinking blocks
	Signature string                 `json:"signature,omitempty"`   // For thinking blocks (verification signature)
	ID        string                 `json:"id,omitempty"`          // For tool_use blocks
	Name      string                 `json:"name,omitempty"`        // For tool_use blocks
	Input     map[string]interface{} `json:"input,omitempty"`       // For tool_use blocks
	ToolUseID string                 `json:"tool_use_id,omitempty"` // For tool_result blocks
	Content   interface{}            `json:"content,omitempty"`     // For tool_result blocks (string or array)
	IsError   *bool                  `json:"is_error,omitempty"`    // For tool_result blocks
}
