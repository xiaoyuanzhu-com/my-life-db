package models

// ClaudeMessage represents a message in the Claude API format.
// The Content field has different types depending on the role:
// - User messages: string (plain text) or []ContentBlock
// - Assistant messages: []ContentBlock (structured content with text and tool calls)
type ClaudeMessage struct {
	Role         string      `json:"role"`                    // "user" or "assistant"
	Content      interface{} `json:"content,omitempty"`       // string for user, []ContentBlock for assistant
	Model        string      `json:"model,omitempty"`         // Model used (e.g., "claude-opus-4-5-20251101")
	ID           string      `json:"id,omitempty"`            // Message ID from Claude API
	Type         string      `json:"type,omitempty"`          // "message" for assistant responses
	StopReason   *string     `json:"stop_reason,omitempty"`   // Why generation stopped (e.g., "end_turn", "tool_use")
	StopSequence *string     `json:"stop_sequence,omitempty"` // Stop sequence that triggered stop (if any)
	Usage        *TokenUsage `json:"usage,omitempty"`         // Token usage for this message
}

// TokenUsage represents token usage statistics
type TokenUsage struct {
	InputTokens              int           `json:"input_tokens,omitempty"`
	OutputTokens             int           `json:"output_tokens,omitempty"`
	CacheCreationInputTokens int           `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int           `json:"cache_read_input_tokens,omitempty"`
	CacheCreation            *CacheDetails `json:"cache_creation,omitempty"`
	ServiceTier              string        `json:"service_tier,omitempty"` // e.g., "standard"
}

// CacheDetails represents cache creation details
type CacheDetails struct {
	Ephemeral5mInputTokens int `json:"ephemeral_5m_input_tokens,omitempty"`
	Ephemeral1hInputTokens int `json:"ephemeral_1h_input_tokens,omitempty"`
}
