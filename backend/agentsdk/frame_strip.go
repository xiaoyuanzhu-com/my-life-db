package agentsdk

import "encoding/json"

// StripHeavyToolCallContent removes large payloads from ACP tool_call and
// tool_call_update frames before broadcasting over WebSocket.
//
// ⚠️  DESIGN VIOLATION: Raw frame integrity
//
// Same rationale as claude.StripHeavyToolContent — we mutate frames before
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
//     The frontend reads results from tool_call_update.rawOutput instead.
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

	// Strip rawOutput (large tool output like file reads, command results)
	if _, hasRawOutput := msg["rawOutput"]; hasRawOutput {
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

	if !stripped {
		return data
	}

	result, err := json.Marshal(msg)
	if err != nil {
		return data
	}
	return result
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
