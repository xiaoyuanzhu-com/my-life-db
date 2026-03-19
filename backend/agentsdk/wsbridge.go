package agentsdk

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// WSBridge translates agentsdk.Event objects into the JSON message format
// the existing frontend expects. Each Event may produce zero or more JSON
// messages (e.g., EventMessage with multiple blocks could produce multiple).
type WSBridge struct {
	SessionID string
}

// TranslateEvent converts an Event into zero or more JSON-encoded messages
// matching the frontend's expected wire format.
func (b *WSBridge) TranslateEvent(event Event) [][]byte {
	switch event.Type {
	case EventDelta:
		return b.translateDelta(event)
	case EventMessage:
		return b.translateMessage(event)
	case EventPermissionRequest:
		return b.translatePermissionRequest(event)
	case EventComplete:
		return b.translateComplete(event)
	default:
		return nil
	}
}

// SystemInitMessage returns a synthetic system:init JSON message.
func (b *WSBridge) SystemInitMessage() []byte {
	msg := map[string]any{
		"type":      "system",
		"uuid":      uuid.New().String(),
		"timestamp": time.Now().UnixMilli(),
		"sessionId": b.SessionID,
		"subtype":   "init",
	}
	data, _ := json.Marshal(msg)
	return data
}

// UserMessage returns a synthetic user message JSON echoed back from input.
func (b *WSBridge) UserMessage(content string, msgUUID string) []byte {
	msg := map[string]any{
		"type":      "user",
		"uuid":      msgUUID,
		"timestamp": time.Now().UnixMilli(),
		"sessionId": b.SessionID,
		"message": map[string]any{
			"role": "user",
			"content": []map[string]any{
				{"type": "text", "text": content},
			},
		},
	}
	data, _ := json.Marshal(msg)
	return data
}

func (b *WSBridge) translateDelta(event Event) [][]byte {
	msg := map[string]any{
		"type":      "stream_event",
		"uuid":      uuid.New().String(),
		"timestamp": time.Now().UnixMilli(),
		"sessionId": b.SessionID,
		"event": map[string]any{
			"type": "content_block_delta",
			"delta": map[string]any{
				"type": "text_delta",
				"text": event.Delta,
			},
		},
	}
	data, _ := json.Marshal(msg)
	return [][]byte{data}
}

func (b *WSBridge) translateMessage(event Event) [][]byte {
	if event.Message == nil || len(event.Message.Content) == 0 {
		return nil
	}

	var results [][]byte
	for _, block := range event.Message.Content {
		var data []byte
		switch block.Type {
		case BlockText:
			msg := map[string]any{
				"type":      "assistant",
				"uuid":      uuid.New().String(),
				"timestamp": time.Now().UnixMilli(),
				"sessionId": b.SessionID,
				"message": map[string]any{
					"role": "assistant",
					"content": []map[string]any{
						{"type": "text", "text": block.Text},
					},
				},
			}
			data, _ = json.Marshal(msg)

		case BlockThinking:
			msg := map[string]any{
				"type":      "stream_event",
				"uuid":      uuid.New().String(),
				"timestamp": time.Now().UnixMilli(),
				"sessionId": b.SessionID,
				"event": map[string]any{
					"type": "content_block_delta",
					"delta": map[string]any{
						"type":     "thinking_delta",
						"thinking": block.Text,
					},
				},
			}
			data, _ = json.Marshal(msg)

		case BlockToolUse:
			// ToolInput is already json.RawMessage; use it directly
			var inputVal any = json.RawMessage("{}")
			if len(block.ToolInput) > 0 {
				inputVal = json.RawMessage(block.ToolInput)
			}
			msg := map[string]any{
				"type":      "assistant",
				"uuid":      uuid.New().String(),
				"timestamp": time.Now().UnixMilli(),
				"sessionId": b.SessionID,
				"message": map[string]any{
					"role": "assistant",
					"content": []map[string]any{
						{
							"type":  "tool_use",
							"id":    block.ToolUseID,
							"name":  block.ToolName,
							"input": inputVal,
						},
					},
				},
			}
			data, _ = json.Marshal(msg)

		case BlockToolResult:
			msg := map[string]any{
				"type":      "assistant",
				"uuid":      uuid.New().String(),
				"timestamp": time.Now().UnixMilli(),
				"sessionId": b.SessionID,
				"message": map[string]any{
					"role": "assistant",
					"content": []map[string]any{
						{
							"type":        "tool_result",
							"tool_use_id": block.ToolUseID,
							"content":     block.Text,
						},
					},
				},
			}
			data, _ = json.Marshal(msg)

		default:
			continue
		}

		if data != nil {
			results = append(results, data)
		}
	}
	return results
}

func (b *WSBridge) translatePermissionRequest(event Event) [][]byte {
	if event.PermissionRequest == nil {
		return nil
	}
	pr := event.PermissionRequest

	// PermissionRequest.Input is already json.RawMessage
	var inputVal any = json.RawMessage("{}")
	if len(pr.Input) > 0 {
		inputVal = json.RawMessage(pr.Input)
	}

	// Build permission_suggestions from Options
	permSuggestions := make([]map[string]any, 0, len(pr.Options))
	for _, opt := range pr.Options {
		permSuggestions = append(permSuggestions, map[string]any{
			"id":   opt.ID,
			"kind": opt.Kind,
			"name": opt.Name,
		})
	}

	msg := map[string]any{
		"type":       "control_request",
		"uuid":       "perm:" + pr.ID,
		"timestamp":  time.Now().UnixMilli(),
		"sessionId":  b.SessionID,
		"request_id": pr.ID,
		"request": map[string]any{
			"subtype":                "can_use_tool",
			"tool_name":             pr.Tool,
			"input":                 inputVal,
			"permission_suggestions": permSuggestions,
		},
	}
	data, _ := json.Marshal(msg)
	return [][]byte{data}
}

func (b *WSBridge) translateComplete(event Event) [][]byte {
	msg := map[string]any{
		"type":      "result",
		"uuid":      uuid.New().String(),
		"timestamp": time.Now().UnixMilli(),
		"sessionId": b.SessionID,
		"result": map[string]any{
			"cost_usd":        0,
			"duration_ms":     0,
			"duration_api_ms": 0,
			"input_tokens":    0,
			"output_tokens":   0,
			"num_turns":       1,
		},
	}
	if event.Usage != nil {
		result := msg["result"].(map[string]any)
		result["input_tokens"] = event.Usage.InputTokens
		result["output_tokens"] = event.Usage.OutputTokens
	}
	data, _ := json.Marshal(msg)
	return [][]byte{data}
}
