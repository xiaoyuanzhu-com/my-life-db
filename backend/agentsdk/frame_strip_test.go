package agentsdk

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStripHeavyToolCallContent_ToolCall(t *testing.T) {
	// Simulate a tool_call frame with heavy content[] and rawInput.content
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tc-1",
		"title":         "Edit /src/main.go",
		"kind":          "edit",
		"status":        "running",
		"content": []interface{}{
			map[string]interface{}{
				"type":    "diff",
				"path":    "/src/main.go",
				"newText": strings.Repeat("x", 50000), // 50KB
				"oldText": strings.Repeat("y", 50000), // 50KB
			},
		},
		"rawInput": map[string]interface{}{
			"file_path":  "/src/main.go",
			"old_string": "func old()",
			"new_string": "func new()",
			"content":    strings.Repeat("z", 50000), // 50KB
		},
		"rawOutput": strings.Repeat("o", 50000), // 50KB
	}

	data, _ := json.Marshal(frame)
	originalSize := len(data)
	stripped := StripHeavyToolCallContent(data)
	strippedSize := len(stripped)

	t.Logf("original=%d bytes, stripped=%d bytes (%.0f%% reduction)",
		originalSize, strippedSize, float64(originalSize-strippedSize)/float64(originalSize)*100)

	var result map[string]interface{}
	if err := json.Unmarshal(stripped, &result); err != nil {
		t.Fatalf("stripped JSON is invalid: %v", err)
	}

	// content[] should be gone
	if _, has := result["content"]; has {
		t.Error("content[] should be stripped")
	}

	// rawOutput should be gone
	if _, has := result["rawOutput"]; has {
		t.Error("rawOutput should be stripped")
	}

	// rawInput.content should be gone, but other fields preserved
	rawInput := result["rawInput"].(map[string]interface{})
	if _, has := rawInput["content"]; has {
		t.Error("rawInput.content should be stripped")
	}
	if rawInput["file_path"] != "/src/main.go" {
		t.Error("rawInput.file_path should be preserved")
	}
	if rawInput["old_string"] != "func old()" {
		t.Error("rawInput.old_string should be preserved")
	}
	if rawInput["new_string"] != "func new()" {
		t.Error("rawInput.new_string should be preserved")
	}

	// Metadata should be preserved
	if result["toolCallId"] != "tc-1" {
		t.Error("toolCallId should be preserved")
	}
	if result["title"] != "Edit /src/main.go" {
		t.Error("title should be preserved")
	}
	if result["kind"] != "edit" {
		t.Error("kind should be preserved")
	}

	// Should be significantly smaller
	if strippedSize > originalSize/2 {
		t.Errorf("expected significant size reduction, got %d -> %d", originalSize, strippedSize)
	}
}

func TestStripHeavyToolCallContent_ToolCallUpdate(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-1",
		"content": []interface{}{
			map[string]interface{}{
				"type":    "diff",
				"newText": strings.Repeat("x", 10000),
			},
		},
		"rawOutput": strings.Repeat("o", 10000),
	}

	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	if _, has := result["content"]; has {
		t.Error("content[] should be stripped from tool_call_update")
	}
	if _, has := result["rawOutput"]; has {
		t.Error("rawOutput should be stripped from tool_call_update")
	}
	if result["toolCallId"] != "tc-1" {
		t.Error("toolCallId should be preserved")
	}
}

func TestStripHeavyToolCallContent_NonToolFramePassthrough(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "agent_message_chunk",
		"content": map[string]interface{}{
			"type": "text",
			"text": "hello world",
		},
	}

	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	// Should be unchanged (byte-for-byte)
	if string(stripped) != string(data) {
		t.Error("non-tool frames should not be modified")
	}
}

func TestStripHeavyToolCallContent_NoHeavyFields(t *testing.T) {
	// A tool_call with no heavy fields should pass through unchanged
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tc-1",
		"title":         "Glob *.go",
		"kind":          "glob",
		"rawInput": map[string]interface{}{
			"pattern": "*.go",
		},
	}

	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	// Should be unchanged
	if string(stripped) != string(data) {
		t.Error("tool_call without heavy fields should not be modified")
	}
}

func TestStripHeavyPermissionContent(t *testing.T) {
	frame := map[string]interface{}{
		"type": "permission.request",
		"toolCall": map[string]interface{}{
			"toolCallId": "tc-1",
			"title":      "Edit /src/main.go",
			"kind":       "edit",
			"content": []interface{}{
				map[string]interface{}{
					"type":    "diff",
					"newText": strings.Repeat("x", 50000),
				},
			},
			"rawInput": map[string]interface{}{
				"file_path":  "/src/main.go",
				"old_string": "func old()",
				"new_string": "func new()",
				"content":    strings.Repeat("z", 50000),
			},
			"rawOutput": strings.Repeat("o", 50000),
		},
		"options": []interface{}{
			map[string]interface{}{
				"optionId": "allow",
				"name":     "Allow once",
				"kind":     "allow_once",
			},
		},
	}

	data, _ := json.Marshal(frame)
	stripped := StripHeavyPermissionContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	toolCall := result["toolCall"].(map[string]interface{})

	if _, has := toolCall["content"]; has {
		t.Error("toolCall.content should be stripped")
	}
	if _, has := toolCall["rawOutput"]; has {
		t.Error("toolCall.rawOutput should be stripped")
	}

	rawInput := toolCall["rawInput"].(map[string]interface{})
	if _, has := rawInput["content"]; has {
		t.Error("toolCall.rawInput.content should be stripped")
	}
	if rawInput["file_path"] != "/src/main.go" {
		t.Error("toolCall.rawInput.file_path should be preserved")
	}

	// Options should be preserved
	options := result["options"].([]interface{})
	if len(options) != 1 {
		t.Error("options should be preserved")
	}
}

func TestStripHeavyPermissionContent_NoToolCall(t *testing.T) {
	// Malformed frame without toolCall — should pass through
	frame := map[string]interface{}{
		"type": "permission.request",
	}

	data, _ := json.Marshal(frame)
	stripped := StripHeavyPermissionContent(data)

	if string(stripped) != string(data) {
		t.Error("frame without toolCall should not be modified")
	}
}
