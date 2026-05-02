package agentsdk

import "encoding/json"

// StripHeavyToolCallContent removes large payloads from ACP tool_call_update
// frames before broadcasting over WebSocket.
//
// ⚠️  STRICT ALLOWLIST — do not broaden without explicit review.
//
// We previously applied a broad strip across all tool_call/tool_call_update
// frames. That was disabled because it hid payloads needed by some renderers
// (e.g. the image renderer's resource_link blocks). This re-enabled version
// is intentionally narrow: only specific tool_call_update frames for
// allowlisted tools are touched, and only the specific fields below.
//
// Frames NOT modified:
//   - Any sessionUpdate other than tool_call_update (including tool_call)
//   - Any tool not in the allowlist (Read, Grep, Bash, Edit, Write)
//   - Permission frames (handled separately if/when re-enabled)
//
// Per-tool rules (tool_call_update only). Each rule strips a specific field
// only if it is present in the frame; non-present fields are left alone.
//
//   Read:
//     - top-level "content" and "rawOutput"
//     - _meta.claudeCode.toolResponse.file.content
//     - _meta.claudeCode.toolResponse.file.base64 (image reads)
//
//   Grep:
//     - top-level "content" and "rawOutput"
//     - _meta.claudeCode.toolResponse.content
//
//   Bash:
//     - top-level "content" and "rawOutput"
//
//   Edit:
//     - content[*].oldText, content[*].newText
//     - rawInput.old_string, rawInput.new_string
//     - toolResponse.oldString, toolResponse.newString,
//       toolResponse.originalFile, toolResponse.structuredPatch
//
//   Write:
//     - content[*].newText (the diff block)
//     - rawInput.content (the file body)
//
// All preserved fields are what the frontend renderers actually consume:
// titles, file paths, line numbers, tool names, status, etc.
func StripHeavyToolCallContent(data []byte) []byte {
	var envelope struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return data
	}
	if envelope.SessionUpdate != "tool_call_update" {
		return data
	}

	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return data
	}

	cc := getACPMeta(msg)
	if cc == nil {
		return data
	}
	toolName, _ := cc["toolName"].(string)

	stripped := false
	switch toolName {
	case "Read":
		if stripTopLevelOutput(msg) {
			stripped = true
		}
		if resp, ok := cc["toolResponse"].(map[string]interface{}); ok {
			if file, ok := resp["file"].(map[string]interface{}); ok {
				if deleteIfPresent(file, "content") {
					stripped = true
				}
				if deleteIfPresent(file, "base64") {
					stripped = true
				}
			}
		}

	case "Grep":
		if stripTopLevelOutput(msg) {
			stripped = true
		}
		if resp, ok := cc["toolResponse"].(map[string]interface{}); ok {
			if deleteIfPresent(resp, "content") {
				stripped = true
			}
		}

	case "Bash":
		if stripTopLevelOutput(msg) {
			stripped = true
		}

	case "Edit":
		if stripDiffContent(msg) {
			stripped = true
		}
		if rawInput, ok := msg["rawInput"].(map[string]interface{}); ok {
			if deleteIfPresent(rawInput, "old_string") {
				stripped = true
			}
			if deleteIfPresent(rawInput, "new_string") {
				stripped = true
			}
		}
		if resp, ok := cc["toolResponse"].(map[string]interface{}); ok {
			for _, key := range [...]string{"oldString", "newString", "originalFile", "structuredPatch"} {
				if deleteIfPresent(resp, key) {
					stripped = true
				}
			}
		}

	case "Write":
		if stripDiffContent(msg) {
			stripped = true
		}
		if rawInput, ok := msg["rawInput"].(map[string]interface{}); ok {
			if deleteIfPresent(rawInput, "content") {
				stripped = true
			}
		}

	default:
		return data
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

// stripTopLevelOutput removes the top-level "content" array and "rawOutput"
// fields. These appear only on the completed result frame, so presence is the
// trigger. Returns true if anything was removed.
func stripTopLevelOutput(msg map[string]interface{}) bool {
	stripped := false
	if deleteIfPresent(msg, "content") {
		stripped = true
	}
	if deleteIfPresent(msg, "rawOutput") {
		stripped = true
	}
	return stripped
}

// stripDiffContent removes oldText/newText from each entry of the top-level
// "content" array (the ACP diff blocks emitted by Edit and Write tools).
// Returns true if anything was removed.
func stripDiffContent(msg map[string]interface{}) bool {
	contents, ok := msg["content"].([]interface{})
	if !ok {
		return false
	}
	stripped := false
	for _, item := range contents {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if deleteIfPresent(m, "oldText") {
			stripped = true
		}
		if deleteIfPresent(m, "newText") {
			stripped = true
		}
	}
	return stripped
}

// deleteIfPresent removes key from m and returns true if the key existed.
func deleteIfPresent(m map[string]interface{}, key string) bool {
	if _, has := m[key]; !has {
		return false
	}
	delete(m, key)
	return true
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
