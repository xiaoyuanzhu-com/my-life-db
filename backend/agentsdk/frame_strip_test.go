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

func TestStrip_ReadUpdate_RemovesToolResponseFileBase64(t *testing.T) {
	// Image reads put the encoded image bytes in toolResponse.file.base64
	// instead of toolResponse.file.content.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-read-3",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Read",
				"toolResponse": map[string]interface{}{
					"type": "image",
					"file": map[string]interface{}{
						"base64": strings.Repeat("A", 200000),
						"type":   "image/png",
						"dimensions": map[string]interface{}{
							"displayHeight":  2000,
							"displayWidth":   924,
							"originalHeight": 2532,
							"originalWidth":  1170,
						},
						"originalSize": 127137,
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

	if _, has := file["base64"]; has {
		t.Error("Read+update: toolResponse.file.base64 should be stripped")
	}
	if file["type"] != "image/png" {
		t.Error("toolResponse.file.type should be preserved")
	}
	if _, has := file["dimensions"]; !has {
		t.Error("toolResponse.file.dimensions should be preserved")
	}
	if _, has := file["originalSize"]; !has {
		t.Error("toolResponse.file.originalSize should be preserved")
	}
}

func TestStrip_WriteUpdate_StripsContentAndRawInput(t *testing.T) {
	// Write tool_call_update: strip content[*].newText (diff block) and
	// rawInput.content (the file body). Preserve path, type, file_path,
	// locations, and other metadata.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-write-1",
		"kind":          "edit",
		"title":         "Write /src/Dockerfile",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Write",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type":    "diff",
				"path":    "/src/Dockerfile",
				"newText": strings.Repeat("d", 50000),
			},
		},
		"locations": []interface{}{
			map[string]interface{}{"path": "/src/Dockerfile"},
		},
		"rawInput": map[string]interface{}{
			"file_path": "/src/Dockerfile",
			"content":   strings.Repeat("d", 50000),
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	if err := json.Unmarshal(stripped, &result); err != nil {
		t.Fatalf("invalid stripped JSON: %v", err)
	}

	contents := result["content"].([]interface{})
	first := contents[0].(map[string]interface{})
	if _, has := first["newText"]; has {
		t.Error("Write: content[0].newText should be stripped")
	}
	if first["path"] != "/src/Dockerfile" {
		t.Error("Write: content[0].path should be preserved")
	}
	if first["type"] != "diff" {
		t.Error("Write: content[0].type should be preserved")
	}

	rawInput := result["rawInput"].(map[string]interface{})
	if _, has := rawInput["content"]; has {
		t.Error("Write: rawInput.content should be stripped")
	}
	if rawInput["file_path"] != "/src/Dockerfile" {
		t.Error("Write: rawInput.file_path should be preserved")
	}

	if result["title"] != "Write /src/Dockerfile" {
		t.Error("Write: title should be preserved")
	}
	if result["kind"] != "edit" {
		t.Error("Write: kind should be preserved")
	}
	if _, has := result["locations"]; !has {
		t.Error("Write: locations should be preserved")
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

func TestStrip_BashUpdate_RemovesToolResponseStdoutStderr(t *testing.T) {
	// Bash tool_call_update with toolResponse: strip stdout and stderr while
	// preserving the small status fields (interrupted, isImage, noOutputExpected).
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-bash-3",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "Bash",
				"toolResponse": map[string]interface{}{
					"interrupted":      false,
					"isImage":          false,
					"noOutputExpected": false,
					"stderr":           strings.Repeat("e", 50000),
					"stdout":           strings.Repeat("o", 50000),
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

	if _, has := resp["stdout"]; has {
		t.Error("Bash+update: toolResponse.stdout should be stripped")
	}
	if _, has := resp["stderr"]; has {
		t.Error("Bash+update: toolResponse.stderr should be stripped")
	}
	if resp["interrupted"] != false {
		t.Error("Bash+update: toolResponse.interrupted should be preserved")
	}
	if resp["isImage"] != false {
		t.Error("Bash+update: toolResponse.isImage should be preserved")
	}
	if resp["noOutputExpected"] != false {
		t.Error("Bash+update: toolResponse.noOutputExpected should be preserved")
	}
}

func TestStrip_ExitPlanMode_StripsRawInputPlan(t *testing.T) {
	// ExitPlanMode tool_call_update: strip rawInput.plan (duplicate of
	// content[0].content.text) while preserving content[], rawInput.planFilePath,
	// title, kind, and _meta.claudeCode.toolName.
	planMarkdown := strings.Repeat("# heading\n", 5000)
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-plan-1",
		"kind":          "switch_mode",
		"title":         "Ready to code?",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "ExitPlanMode",
			},
		},
		"content": []interface{}{
			map[string]interface{}{
				"type": "content",
				"content": map[string]interface{}{
					"type": "text",
					"text": planMarkdown,
				},
			},
		},
		"rawInput": map[string]interface{}{
			"plan":         planMarkdown,
			"planFilePath": "/home/x/.claude/plans/foo.md",
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)

	var result map[string]interface{}
	if err := json.Unmarshal(stripped, &result); err != nil {
		t.Fatalf("invalid stripped JSON: %v", err)
	}

	rawInput := result["rawInput"].(map[string]interface{})
	if _, has := rawInput["plan"]; has {
		t.Error("ExitPlanMode: rawInput.plan should be stripped")
	}
	if rawInput["planFilePath"] != "/home/x/.claude/plans/foo.md" {
		t.Error("ExitPlanMode: rawInput.planFilePath should be preserved")
	}

	contents := result["content"].([]interface{})
	first := contents[0].(map[string]interface{})
	inner := first["content"].(map[string]interface{})
	if inner["text"] != planMarkdown {
		t.Error("ExitPlanMode: content[0].content.text should be preserved (frontend reads from here)")
	}

	if result["title"] != "Ready to code?" {
		t.Error("ExitPlanMode: title should be preserved")
	}
	if result["kind"] != "switch_mode" {
		t.Error("ExitPlanMode: kind should be preserved")
	}
}

func TestStrip_ExitPlanMode_NoRawInputPlan_PassesThrough(t *testing.T) {
	// ExitPlanMode without rawInput.plan: nothing strippable, frame should be
	// returned unchanged.
	frame := map[string]interface{}{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "tc-plan-2",
		"_meta": map[string]interface{}{
			"claudeCode": map[string]interface{}{
				"toolName": "ExitPlanMode",
			},
		},
		"rawInput": map[string]interface{}{
			"planFilePath": "/foo.md",
		},
	}
	data, _ := json.Marshal(frame)
	stripped := StripHeavyToolCallContent(data)
	if string(stripped) != string(data) {
		t.Error("ExitPlanMode without rawInput.plan should pass through unchanged")
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
	// Edit tool_call_update without toolResponse: strip rawInput diff strings,
	// but PRESERVE the content[*].oldText/newText diff block — it is the
	// frontend's fallback diff source when the CLI omits structuredPatch.
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

	// content[0] must be preserved intact — it carries the diff the renderer
	// falls back to when structuredPatch is absent.
	contents := result["content"].([]interface{})
	first := contents[0].(map[string]interface{})
	if first["oldText"] != strings.Repeat("a", 50000) {
		t.Error("Edit: content[0].oldText should be preserved")
	}
	if first["newText"] != strings.Repeat("b", 50000) {
		t.Error("Edit: content[0].newText should be preserved")
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
	// Edit tool_call_update with toolResponse: strip heavy toolResponse fields
	// (oldString, newString, originalFile), but PRESERVE structuredPatch AND the
	// content[*] diff block so the renderer can display the diff either way.
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
							"lines":    []interface{}{"-old line", "+new line"},
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
	if first["oldText"] != strings.Repeat("a", 50000) {
		t.Error("Edit: content[0].oldText should be preserved")
	}
	if first["newText"] != strings.Repeat("b", 50000) {
		t.Error("Edit: content[0].newText should be preserved")
	}

	cc := result["_meta"].(map[string]interface{})["claudeCode"].(map[string]interface{})
	resp := cc["toolResponse"].(map[string]interface{})
	for _, key := range []string{"oldString", "newString", "originalFile"} {
		if _, has := resp[key]; has {
			t.Errorf("Edit: toolResponse.%s should be stripped", key)
		}
	}
	// structuredPatch must be preserved — frontend uses it to render the diff.
	sp, has := resp["structuredPatch"].([]interface{})
	if !has {
		t.Fatal("Edit: toolResponse.structuredPatch should be preserved")
	}
	if len(sp) != 1 {
		t.Fatalf("Edit: structuredPatch should have 1 hunk, got %d", len(sp))
	}
	hunk := sp[0].(map[string]interface{})
	lines := hunk["lines"].([]interface{})
	if len(lines) != 2 || lines[0] != "-old line" || lines[1] != "+new line" {
		t.Errorf("Edit: structuredPatch hunk lines not preserved: %v", lines)
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
	for _, toolName := range []string{"Glob", "WebSearch", "MultiEdit"} {
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
