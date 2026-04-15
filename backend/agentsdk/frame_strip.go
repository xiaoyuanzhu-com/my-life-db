package agentsdk

import "encoding/json"

// StripHeavyToolCallContent removes large payloads from ACP tool_call and
// tool_call_update frames before broadcasting over WebSocket.
//
// ⚠️  DESIGN VIOLATION: Raw frame integrity
//
// Same rationale as the legacy strip helper — we mutate frames before
// they reach the frontend to avoid shipping large, unrenderable payloads over
// WebSocket and holding them in memory.
//
// Stripped fields (not used by any frontend renderer):
//
//   - content[]: ACP ToolCallContent array (diff newText/oldText, terminal embeds).
//     The frontend renders diffs from rawInput.old_string / rawInput.new_string instead.
//
//   - rawInput.content: duplicates file content already captured in the content[] array.
//     Not used by any tool renderer.
//
//   - rawOutput: large tool output (e.g. file reads, command output).
//     Exception: rawOutput is PRESERVED for small-result tools (WebSearch,
//     WebFetch, ToolSearch) whose renderers need the content.
//
//   - _meta.claudeCode.toolResponse.file.content: file content from the Read tool.
//     The frontend only needs metadata (numLines, startLine, totalLines) for the
//     summary line; the actual content is not rendered.
//
//   - _meta.claudeCode.toolResponse.originalFile: full file snapshot from the Edit
//     tool. The frontend renders diffs from oldString/newString; originalFile is unused.
//
//   - _meta.claudeCode.toolResponse.content: full file content from the Write tool.
//     The frontend only needs filePath and type; the actual content is not rendered.
//
// Preserved fields (used by frontend renderers):
//
//   - rawInput.old_string, rawInput.new_string, rawInput.file_path, rawInput.replace_all
//   - rawInput.command, rawInput.description (Bash tool)
//   - rawInput.pattern, rawInput.path, rawInput.glob (Grep/Glob tools)
//   - kind, toolCallId, title, status, locations
//
// Do NOT add new cases here without explicit review.
func StripHeavyToolCallContent(data []byte) []byte {
	// Quick check: only tool_call and tool_call_update frames have heavy payloads.
	var envelope struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return data
	}
	if envelope.SessionUpdate != "tool_call" && envelope.SessionUpdate != "tool_call_update" {
		return data
	}

	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return data
	}

	stripped := false

	// Strip content[] array (ACP ToolCallContent — diffs, terminals, etc.)
	if _, hasContent := msg["content"]; hasContent {
		delete(msg, "content")
		stripped = true
	}

	// Strip rawOutput (large tool output like file reads, command results).
	// Preserve for small-result tools whose frontend renderers need the content.
	if _, hasRawOutput := msg["rawOutput"]; hasRawOutput && !preserveRawOutput(msg) {
		delete(msg, "rawOutput")
		stripped = true
	}

	// Strip rawInput.content (duplicates content[] data, not used by renderers)
	if rawInput, ok := msg["rawInput"].(map[string]interface{}); ok {
		if _, hasContent := rawInput["content"]; hasContent {
			delete(rawInput, "content")
			stripped = true
		}
	}

	// Strip file content from Read tool's toolResponse.
	//
	// PRINCIPLE: strip conservatively and explicitly, tool by tool. Each tool's
	// toolResponse has a different shape and the frontend renderer may depend on
	// any field. Only add a new case here after confirming the renderer doesn't
	// need the stripped field.
	if cc := getACPMeta(msg); cc != nil {
		toolName, _ := cc["toolName"].(string)
		switch toolName {
		case "Read":
			if stripReadToolResponseContent(cc) {
				stripped = true
			}
		case "Edit":
			if stripEditToolResponseContent(cc) {
				stripped = true
			}
		case "Write":
			if stripWriteToolResponseContent(cc) {
				stripped = true
			}
		}
	}

	if !stripped {
		return data
	}

	result, err := json.Marshal(msg)
	if err != nil {
		return data
	}
	return result
}

// getACPMeta returns the _meta.claudeCode map if present (protocol field from the CLI).
func getACPMeta(msg map[string]interface{}) map[string]interface{} {
	meta, _ := msg["_meta"].(map[string]interface{})
	if meta == nil {
		return nil
	}
	cc, _ := meta["claudeCode"].(map[string]interface{})
	return cc
}

// preserveRawOutput returns true for tools whose rawOutput is small and needed
// by the frontend renderer (e.g. WebSearch results, fetched page content).
// Checks _meta.claudeCode.toolName which the CLI populates on every frame.
func preserveRawOutput(msg map[string]interface{}) bool {
	cc := getACPMeta(msg)
	if cc == nil {
		return false
	}
	toolName, _ := cc["toolName"].(string)
	switch toolName {
	case "WebSearch", "WebFetch", "ToolSearch":
		return true
	}
	return false
}

// stripReadToolResponseContent removes file content from the Read tool's
// toolResponse, keeping metadata the frontend needs for the summary line.
//
// Read toolResponse shape:
//
//	{ type: "text", file: { content, filePath, numLines, startLine, totalLines } }
//
// Stripped:  file.content (the actual file text — can be thousands of lines)
// Preserved: file.filePath, file.numLines, file.startLine, file.totalLines
func stripReadToolResponseContent(cc map[string]interface{}) bool {
	resp, ok := cc["toolResponse"].(map[string]interface{})
	if !ok {
		return false
	}
	file, ok := resp["file"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, has := file["content"]; !has {
		return false
	}
	delete(file, "content")
	return true
}

// stripEditToolResponseContent removes the full file snapshot from the Edit
// tool's toolResponse. The frontend renders diffs from oldString/newString
// (or structuredPatch); originalFile is not used by the renderer.
//
// Edit toolResponse shape:
//
//	{ filePath, oldString, newString, originalFile, replaceAll, structuredPatch, userModified }
//
// Stripped:  originalFile (full file text before edit)
// Preserved: filePath, oldString, newString, replaceAll, structuredPatch, userModified
func stripEditToolResponseContent(cc map[string]interface{}) bool {
	resp, ok := cc["toolResponse"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, has := resp["originalFile"]; !has {
		return false
	}
	delete(resp, "originalFile")
	return true
}

// stripWriteToolResponseContent removes the full file content from the Write
// tool's toolResponse. The frontend only needs filePath and type for rendering;
// the actual file content is not displayed.
//
// Write toolResponse shape:
//
//	{ content, filePath, originalFile, structuredPatch, type }
//
// Stripped:  content (full file text being written)
// Preserved: filePath, originalFile, structuredPatch, type
func stripWriteToolResponseContent(cc map[string]interface{}) bool {
	resp, ok := cc["toolResponse"].(map[string]interface{})
	if !ok {
		return false
	}
	if _, has := resp["content"]; !has {
		return false
	}
	delete(resp, "content")
	return true
}

// StripHeavyPermissionContent strips large payloads from permission.request
// frames. The toolCall object embedded in the permission frame carries the same
// content[] and rawInput.content fields as tool_call frames.
func StripHeavyPermissionContent(data []byte) []byte {
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return data
	}

	toolCall, ok := msg["toolCall"].(map[string]interface{})
	if !ok {
		return data
	}

	stripped := false

	if _, hasContent := toolCall["content"]; hasContent {
		delete(toolCall, "content")
		stripped = true
	}

	if _, hasRawOutput := toolCall["rawOutput"]; hasRawOutput {
		delete(toolCall, "rawOutput")
		stripped = true
	}

	if rawInput, ok := toolCall["rawInput"].(map[string]interface{}); ok {
		if _, hasContent := rawInput["content"]; hasContent {
			delete(rawInput, "content")
			stripped = true
		}
	}

	if !stripped {
		return data
	}

	result, err := json.Marshal(msg)
	if err != nil {
		return data
	}
	return result
}
