package sdk

import (
	"encoding/json"
	"fmt"
	"time"
)

// ParseMessageFromMap parses a map[string]any into a typed Message object.
// This is used when messages come from channels as maps (like Python SDK).
func ParseMessageFromMap(msg map[string]any) (Message, error) {
	// Re-marshal to JSON and use existing parser
	// This keeps parsing logic DRY and is efficient enough for our use case
	data, err := json.Marshal(msg)
	if err != nil {
		return nil, &MessageParseError{Message: "failed to marshal message map", Cause: err}
	}
	return ParseMessage(data)
}

// ParseMessage parses raw JSON data into a typed Message object
func ParseMessage(data []byte) (Message, error) {
	if len(data) == 0 {
		return nil, &MessageParseError{Message: "empty message data", Data: data}
	}

	// First parse the type field
	var base struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &base); err != nil {
		return nil, &MessageParseError{Message: "failed to parse message type", Data: data, Cause: err}
	}

	if base.Type == "" {
		return nil, &MessageParseError{Message: "message missing 'type' field", Data: data}
	}

	switch base.Type {
	case "user":
		return parseUserMessage(data)

	case "assistant":
		return parseAssistantMessage(data)

	case "system":
		return parseSystemMessage(data)

	case "result":
		return parseResultMessage(data)

	case "stream_event":
		return parseStreamEvent(data)

	case "control_request", "control_response":
		// Return raw message for control protocol messages
		return RawMessage{
			Type: MessageType(base.Type),
			Raw:  data,
		}, nil

	default:
		// Unknown type - return as raw message for passthrough
		return RawMessage{
			Type: MessageType(base.Type),
			Raw:  data,
		}, nil
	}
}

func parseUserMessage(data []byte) (Message, error) {
	var raw struct {
		Type            string  `json:"type"`
		UUID            string  `json:"uuid,omitempty"`
		Timestamp       string  `json:"timestamp,omitempty"`
		SessionID       string  `json:"sessionId,omitempty"`
		ParentToolUseID *string `json:"parent_tool_use_id,omitempty"`
		ToolUseResult   map[string]any `json:"tool_use_result,omitempty"`
		Message         struct {
			Role    string `json:"role"`
			Content any    `json:"content"`
		} `json:"message"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, &MessageParseError{Message: "failed to parse user message", Data: data, Cause: err}
	}

	msg := UserMessage{
		Type:            MessageTypeUser,
		UUID:            raw.UUID,
		SessionID:       raw.SessionID,
		ParentToolUseID: raw.ParentToolUseID,
		ToolUseResult:   raw.ToolUseResult,
	}

	if raw.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, raw.Timestamp); err == nil {
			msg.Timestamp = t
		}
	}

	msg.Message.Role = raw.Message.Role
	msg.Message.Content = raw.Message.Content

	return msg, nil
}

func parseAssistantMessage(data []byte) (Message, error) {
	var raw struct {
		Type            string  `json:"type"`
		UUID            string  `json:"uuid,omitempty"`
		Timestamp       string  `json:"timestamp,omitempty"`
		SessionID       string  `json:"sessionId,omitempty"`
		ParentToolUseID *string `json:"parent_tool_use_id,omitempty"`
		Message         struct {
			Role    string `json:"role"`
			Model   string `json:"model"`
			Content []struct {
				Type      string         `json:"type"`
				Text      string         `json:"text,omitempty"`
				Thinking  string         `json:"thinking,omitempty"`
				Signature string         `json:"signature,omitempty"`
				ID        string         `json:"id,omitempty"`
				Name      string         `json:"name,omitempty"`
				Input     map[string]any `json:"input,omitempty"`
				ToolUseID string         `json:"tool_use_id,omitempty"`
				Content   any            `json:"content,omitempty"`
				IsError   bool           `json:"is_error,omitempty"`
			} `json:"content"`
		} `json:"message"`
		Error string `json:"error,omitempty"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, &MessageParseError{Message: "failed to parse assistant message", Data: data, Cause: err}
	}

	msg := AssistantMessage{
		Type:            MessageTypeAssistant,
		UUID:            raw.UUID,
		SessionID:       raw.SessionID,
		ParentToolUseID: raw.ParentToolUseID,
		Error:           raw.Error,
	}

	if raw.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, raw.Timestamp); err == nil {
			msg.Timestamp = t
		}
	}

	msg.Message.Role = raw.Message.Role
	msg.Message.Model = raw.Message.Model

	// Parse content blocks
	for _, block := range raw.Message.Content {
		switch block.Type {
		case "text":
			msg.Message.Content = append(msg.Message.Content, TextBlock{
				Type: "text",
				Text: block.Text,
			})

		case "thinking":
			msg.Message.Content = append(msg.Message.Content, ThinkingBlock{
				Type:      "thinking",
				Thinking:  block.Thinking,
				Signature: block.Signature,
			})

		case "tool_use":
			msg.Message.Content = append(msg.Message.Content, ToolUseBlock{
				Type:  "tool_use",
				ID:    block.ID,
				Name:  block.Name,
				Input: block.Input,
			})

		case "tool_result":
			msg.Message.Content = append(msg.Message.Content, ToolResultBlock{
				Type:      "tool_result",
				ToolUseID: block.ToolUseID,
				Content:   block.Content,
				IsError:   block.IsError,
			})
		}
	}

	return msg, nil
}

func parseSystemMessage(data []byte) (Message, error) {
	var raw struct {
		Type      string `json:"type"`
		UUID      string `json:"uuid,omitempty"`
		Subtype   string `json:"subtype"`
		Timestamp string `json:"timestamp,omitempty"`
		SessionID string `json:"sessionId,omitempty"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, &MessageParseError{Message: "failed to parse system message", Data: data, Cause: err}
	}

	// Parse full message as map for data field
	var fullMsg map[string]any
	json.Unmarshal(data, &fullMsg)

	msg := SystemMessage{
		Type:      MessageTypeSystem,
		UUID:      raw.UUID,
		Subtype:   raw.Subtype,
		SessionID: raw.SessionID,
		Data:      fullMsg,
	}

	if raw.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, raw.Timestamp); err == nil {
			msg.Timestamp = t
		}
	}

	return msg, nil
}

func parseResultMessage(data []byte) (Message, error) {
	var raw struct {
		Type             string         `json:"type"`
		UUID             string         `json:"uuid,omitempty"`
		Subtype          string         `json:"subtype"`
		DurationMs       int            `json:"duration_ms"`
		DurationAPIMs    int            `json:"duration_api_ms"`
		IsError          bool           `json:"is_error"`
		NumTurns         int            `json:"num_turns"`
		SessionID        string         `json:"session_id"`
		TotalCostUSD     *float64       `json:"total_cost_usd,omitempty"`
		Usage            map[string]any `json:"usage,omitempty"`
		Result           string         `json:"result,omitempty"`
		StructuredOutput any            `json:"structured_output,omitempty"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, &MessageParseError{Message: "failed to parse result message", Data: data, Cause: err}
	}

	return ResultMessage{
		Type:             MessageTypeResult,
		UUID:             raw.UUID,
		Subtype:          raw.Subtype,
		DurationMs:       raw.DurationMs,
		DurationAPIMs:    raw.DurationAPIMs,
		IsError:          raw.IsError,
		NumTurns:         raw.NumTurns,
		SessionID:        raw.SessionID,
		TotalCostUSD:     raw.TotalCostUSD,
		Usage:            raw.Usage,
		Result:           raw.Result,
		StructuredOutput: raw.StructuredOutput,
	}, nil
}

func parseStreamEvent(data []byte) (Message, error) {
	var raw struct {
		Type            string         `json:"type"`
		UUID            string         `json:"uuid"`
		SessionID       string         `json:"session_id"`
		Event           map[string]any `json:"event"`
		ParentToolUseID *string        `json:"parent_tool_use_id,omitempty"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, &MessageParseError{Message: "failed to parse stream event", Data: data, Cause: err}
	}

	return StreamEvent{
		Type:            MessageTypeStreamEvent,
		UUID:            raw.UUID,
		SessionID:       raw.SessionID,
		Event:           raw.Event,
		ParentToolUseID: raw.ParentToolUseID,
	}, nil
}

// --- Content Block Helpers ---

// GetTextContent extracts all text content from an AssistantMessage
func GetTextContent(msg AssistantMessage) string {
	var result string
	for _, block := range msg.Message.Content {
		if tb, ok := block.(TextBlock); ok {
			if result != "" {
				result += "\n"
			}
			result += tb.Text
		}
	}
	return result
}

// GetToolUses extracts all tool use blocks from an AssistantMessage
func GetToolUses(msg AssistantMessage) []ToolUseBlock {
	var result []ToolUseBlock
	for _, block := range msg.Message.Content {
		if tb, ok := block.(ToolUseBlock); ok {
			result = append(result, tb)
		}
	}
	return result
}

// GetThinkingContent extracts all thinking blocks from an AssistantMessage
func GetThinkingContent(msg AssistantMessage) []ThinkingBlock {
	var result []ThinkingBlock
	for _, block := range msg.Message.Content {
		if tb, ok := block.(ThinkingBlock); ok {
			result = append(result, tb)
		}
	}
	return result
}

// IsResultMessage checks if a message is a ResultMessage
func IsResultMessage(msg Message) bool {
	_, ok := msg.(ResultMessage)
	return ok
}

// IsErrorResult checks if a message is an error result
func IsErrorResult(msg Message) bool {
	if rm, ok := msg.(ResultMessage); ok {
		return rm.IsError
	}
	return false
}

// FormatCost formats the cost in USD
func FormatCost(cost *float64) string {
	if cost == nil {
		return "N/A"
	}
	return fmt.Sprintf("$%.4f", *cost)
}
