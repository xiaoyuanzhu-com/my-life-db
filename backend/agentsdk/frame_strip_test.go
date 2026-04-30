package agentsdk

import (
	"encoding/json"
	"strings"
	"testing"
)

// readCompletedFrame builds a tool_call_update frame for a completed Read tool
// call, matching the shape emitted by the Claude Code ACP CLI.
func readCompletedFrame(payload, output string) []byte {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-read-1",
		"status":        "completed",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Read",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type": "content",
				"content": map[string]interface{}{
					"type": "text",
					"text": payload,
				},
			},
		},
		"rawOutput": output,
	}
	data, _ := json.Marshal(frame)
	return data
}

func TestStrip_ReadCompleted_RemovesContentAndRawOutput(t *testing.T) {
	data := readCompletedFrame(strings.Repeat("x", 50000), strings.Repeat("o", 50000))
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	if err := json.Unmarshal(stripped, &result); err != nil {
		t.Fatalf("invalid stripped JSON: %v", err)
	}

	if _, has := result["content"]; has {
		t.Error("Read+completed: content[] should be stripped")
	}
	if _, has := result["rawOutput"]; has {
		t.Error("Read+completed: rawOutput should be stripped")
	}
	if result["toolCallId"] != "tc-read-1" {
		t.Error("toolCallId should be preserved")
	}
	if result["status"] != "completed" {
		t.Error("status should be preserved")
	}
}

func TestStrip_ReadUpdate_RemovesToolResponseFileContent(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-read-2",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Read",
				"toolResponse": map[string]interface{}{
					"type": "text",
					"file": map[string]interface{}{
						"content":    strings.Repeat("x", 50000),
						"filePath":   "/src/main.go",
						"numLines":   100,
						"startLine":  1,
						"totalLines": 750,
					},
				},
			},
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	if err := json.Unmarshal(stripped, &result); err != nil {
		t.Fatalf("invalid stripped JSON: %v", err)
	}

	cc := result["_meta"].(map[string]interface{})["claudeCode"].(map[string]interface{})
	resp := cc["toolResponse"].(map[string]interface{})
	file := resp["file"].(map[string]interface{})

	if _, has := file["content"]; has {
		t.Error("Read+update: toolResponse.file.content should be stripped")
	}
	if file["filePath"] != "/src/main.go" {
		t.Error("toolResponse.file.filePath should be preserved")
	}
	if _, has := file["totalLines"]; !has {
		t.Error("toolResponse.file.totalLines should be preserved")
	}
}

func TestStrip_GrepCompleted_RemovesContentAndRawOutput(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-grep-1",
		"status":        "completed",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Grep",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type": "content",
				"content": map[string]interface{}{
					"type": "text",
					"text": strings.Repeat("g", 50000),
				},
			},
		},
		"rawOutput": strings.Repeat("o", 50000),
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	if _, has := result["content"]; has {
		t.Error("Grep+completed: content[] should be stripped")
	}
	if _, has := result["rawOutput"]; has {
		t.Error("Grep+completed: rawOutput should be stripped")
	}
}

func TestStrip_GrepUpdate_RemovesToolResponseContent(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-grep-2",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Grep",
				"toolResponse": map[string]interface{}{
					"content":   strings.Repeat("g", 50000),
					"filenames": []interface{}{},
					"mode":      "content",
					"numFiles":  0,
					"numLines":  174,
				},
			},
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	cc := result["_meta"].(map[string]interface{})["claudeCode"].(map[string]interface{})
	resp := cc["toolResponse"].(map[string]interface{})

	if _, has := resp["content"]; has {
		t.Error("Grep+update: toolResponse.content should be stripped")
	}
	if resp["mode"] != "content" {
		t.Error("toolResponse.mode should be preserved")
	}
	if _, has := resp["numLines"]; !has {
		t.Error("toolResponse.numLines should be preserved")
	}
}

func TestStrip_BashCompleted_RemovesContentAndRawOutput(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-bash-1",
		"status":        "completed",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Bash",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type": "content",
				"content": map[string]interface{}{
					"type": "text",
					"text": strings.Repeat("o", 50000),
				},
			},
		},
		"rawOutput": strings.Repeat("o", 50000),
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	if _, has := result["content"]; has {
		t.Error("Bash+completed: content[] should be stripped")
	}
	if _, has := result["rawOutput"]; has {
		t.Error("Bash+completed: rawOutput should be stripped")
	}
}

func TestStrip_BashRunning_PassesThrough(t *testing.T) {
	// Bash without status:completed must not be stripped (e.g. running command).
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-bash-2",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Bash",
			},
		},
		"rawInput": map[string]interface{}{
			"command":     "ls",
			"description": "List dir",
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("Bash without status:completed should pass through unchanged")
	}
}

func TestStrip_EditRawInput_StripsDiffContent(t *testing.T) {
	// Edit tool_call_update without toolResponse: strip rawInput diff strings
	// AND content[*].oldText/newText.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-edit-1",
		"kind":          "edit",
		"title":         "Edit /src/api.ts",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Edit",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type":    "diff",
				"path":    "/src/api.ts",
				"oldText": strings.Repeat("a", 50000),
				"newText": strings.Repeat("b", 50000),
			},
		},
		"locations": []interface{}{
			map[string]interface{}{"path": "/src/api.ts"},
		},
		"rawInput": map[string]interface{}{
			"file_path":   "/src/api.ts",
			"old_string":  strings.Repeat("a", 50000),
			"new_string":  strings.Repeat("b", 50000),
			"replace_all": false,
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	// content[0] must keep path/type but lose oldText/newText.
	contents := result["content"].([]interface{})
	first := contents[0].(map[string]interface{})
	if _, has := first["oldText"]; has {
		t.Error("Edit: content[0].oldText should be stripped")
	}
	if _, has := first["newText"]; has {
		t.Error("Edit: content[0].newText should be stripped")
	}
	if first["path"] != "/src/api.ts" {
		t.Error("Edit: content[0].path should be preserved")
	}
	if first["type"] != "diff" {
		t.Error("Edit: content[0].type should be preserved")
	}

	rawInput := result["rawInput"].(map[string]interface{})
	if _, has := rawInput["old_string"]; has {
		t.Error("Edit: rawInput.old_string should be stripped")
	}
	if _, has := rawInput["new_string"]; has {
		t.Error("Edit: rawInput.new_string should be stripped")
	}
	if rawInput["file_path"] != "/src/api.ts" {
		t.Error("Edit: rawInput.file_path should be preserved")
	}
	if rawInput["replace_all"] != false {
		t.Error("Edit: rawInput.replace_all should be preserved")
	}

	// Top-level metadata preserved.
	if result["title"] != "Edit /src/api.ts" {
		t.Error("Edit: title should be preserved")
	}
	if result["kind"] != "edit" {
		t.Error("Edit: kind should be preserved")
	}
	if _, has := result["locations"]; !has {
		t.Error("Edit: locations should be preserved")
	}
}

func TestStrip_EditToolResponse_StripsResponseAndDiff(t *testing.T) {
	// Edit tool_call_update with toolResponse: strip diff fields from
	// content[*] AND from toolResponse (oldString, newString, originalFile,
	// structuredPatch).
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-edit-2",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Edit",
				"toolResponse": map[string]interface{}{
					"filePath":     "/src/index.ts",
					"newString":    strings.Repeat("b", 50000),
					"oldString":    strings.Repeat("a", 50000),
					"originalFile": strings.Repeat("o", 200000),
					"replaceAll":   false,
					"structuredPatch": []interface{}{
						map[string]interface{}{
							"lines":    []interface{}{},
							"newLines": 3,
							"newStart": 217,
							"oldLines": 33,
							"oldStart": 217,
						},
					},
					"userModified": false,
				},
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type":    "diff",
				"path":    "/src/index.ts",
				"oldText": strings.Repeat("a", 50000),
				"newText": strings.Repeat("b", 50000),
			},
		},
		"locations": []interface{}{
			map[string]interface{}{"line": 217, "path": "/src/index.ts"},
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	json.Unmarshal(stripped, &result)

	contents := result["content"].([]interface{})
	first := contents[0].(map[string]interface{})
	if _, has := first["oldText"]; has {
		t.Error("Edit: content[0].oldText should be stripped")
	}
	if _, has := first["newText"]; has {
		t.Error("Edit: content[0].newText should be stripped")
	}

	cc := result["_meta"].(map[string]interface{})["claudeCode"].(map[string]interface{})
	resp := cc["toolResponse"].(map[string]interface{})
	for _, key := range []string{"oldString", "newString", "originalFile", "structuredPatch"} {
		if _, has := resp[key]; has {
			t.Errorf("Edit: toolResponse.%s should be stripped", key)
		}
	}
	// Preserved fields.
	if resp["filePath"] != "/src/index.ts" {
		t.Error("Edit: toolResponse.filePath should be preserved")
	}
	if resp["replaceAll"] != false {
		t.Error("Edit: toolResponse.replaceAll should be preserved")
	}
	if resp["userModified"] != false {
		t.Error("Edit: toolResponse.userModified should be preserved")
	}
}

func TestStrip_OtherTool_PassesThrough(t *testing.T) {
	// Tools not in the allowlist must not be touched.
	for _, toolName := range []string{"Write", "Glob", "WebSearch", "MultiEdit"} {
		frame := map[string]interface{}{
			"sessionUpdate": "tool_call_update",
			"toolCallId":    "tc-1",
			"status":        "completed",
			"_meta": map[string]interface{}{
				"claudeCode": map[string]interface{}{
					"toolName": toolName,
				},
			},
			"content":   []interface{}{map[string]interface{}{"type": "text", "text": "x"}},
			"rawOutput": "raw",
		}
		data, _ := json.Marshal(frame)
		stripped := StripHeavyToolCallContent(data)
		if string(stripped) != string(data) {
			t.Errorf("tool %q frame should pass through unchanged", toolName)
		}
	}
}

func TestStrip_ToolCall_PassesThrough(t *testing.T) {
	// Initial tool_call frames (not _update) must not be touched, even for Read/Grep.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call",
		"toolCallId":    "tc-1",
		"status":        "in_progress",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Read",
			},
		},
		"content":   []interface{}{map[string]interface{}{"type": "text", "text": "x"}},
		"rawOutput": "raw",
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("tool_call (not _update) frames should pass through unchanged")
	}
}

func TestStrip_NonToolFrame_PassesThrough(t *testing.T) {
	frame := map[string]interface{}{
		"sessionUpdate": "agent_message_chunk",
		"content": map[string]interface{}{
			"type": "text",
			"text": "hello world",
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("non-tool frames should pass through unchanged")
	}
}

func TestStrip_ReadInProgress_PassesThrough(t *testing.T) {
	// Read tool_call_update with non-completed status and no toolResponse —
	// nothing to strip, frame must pass through unchanged.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-1",
		"status":        "in_progress",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Read",
			},
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("Read+in_progress without strippable fields should pass through unchanged")
	}
}

func TestStrip_NoMeta_PassesThrough(t *testing.T) {
	// tool_call_update without _meta.claudeCode.toolName — can't classify, must pass through.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-1",
		"status":        "completed",
		"content":       []interface{}{map[string]interface{}{"type": "text", "text": "x"}},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("frames without _meta.claudeCode should pass through unchanged")
	}
}
