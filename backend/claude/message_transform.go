package claude

import (
	"encoding/json"
	"strings"
)

// StripHeavyToolContent removes large payloads from tool results in user messages.
//
// ⚠️  DESIGN VIOLATION: Raw message integrity
//
// Our principle is to pass Claude Code messages through as raw as possible.
// This function is a reviewed exception — we mutate messages before they reach
// the frontend to avoid shipping large, unrenderable payloads over WebSocket
// and holding them in memory.
//
// Each case was reviewed and agreed upon for performance reasons:
//
//   - Read tool file content (toolUseResult.file.content): 50–65 KB per result.
//     Stripped; line-count metadata (numLines, totalLines) preserved for summaries.
//
//   - Image base64 (toolUseResult.file.base64): 100 KB+ per screenshot.
//     Stripped; dimensions, originalSize, MIME type preserved.
//
//   - Raw tool_result content blocks (message.content[]): duplicates the above.
//     Stripped to empty string for any message where toolUseResult was stripped.
//
// Do NOT add new cases here without explicit review. If the frontend needs
// the data, find another way (e.g., lazy loading, separate endpoint).
//
// Non-user messages and non-heavy tool results are returned unchanged.
func StripHeavyToolContent(data []byte) []byte {
	// Quick-check: only transform "user" type messages (most messages are skipped here)
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || envelope.Type != "user" {
		return data
	}

	// Parse into generic map to preserve all unknown fields during re-serialization
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return data
	}

	stripped := false

	// Strip toolUseResult content for Read results and image base64
	stripped = stripToolUseResult(msg)

	// Also strip the raw tool_result content in message.content[] —
	// these blocks duplicate the data already in toolUseResult.
	if stripped {
		stripToolResultBlocks(msg)
	}

	if !stripped {
		return data
	}

	// Re-serialize
	result, err := json.Marshal(msg)
	if err != nil {
		return data // Fall back to original on marshal error
	}
	return result
}

// stripToolUseResult checks if toolUseResult contains heavy content and strips it.
// Handles:
//   - Read results (type: "text"): strips file.content, preserves numLines/totalLines
//   - Image results (type: "image"): strips file.base64, preserves dimensions/originalSize
//
// Returns true if content was stripped.
func stripToolUseResult(msg map[string]interface{}) bool {
	toolUseResult, ok := msg["toolUseResult"].(map[string]interface{})
	if !ok {
		return false
	}

	switch toolUseResult["type"] {
	case "text":
		return stripReadToolUseResult(toolUseResult)
	case "image":
		return stripImageToolUseResult(toolUseResult)
	default:
		return false
	}
}

// stripReadToolUseResult strips file content from Read tool results.
// Preserves numLines/totalLines metadata for frontend summary rendering.
func stripReadToolUseResult(toolUseResult map[string]interface{}) bool {
	fileObj, ok := toolUseResult["file"].(map[string]interface{})
	if !ok {
		return false
	}

	content, _ := fileObj["content"].(string)
	if content == "" {
		// No content to strip, but still a Read result
		return true
	}

	lineCount := countLines(content)

	// Preserve line count metadata if not already present
	if _, exists := fileObj["numLines"]; !exists {
		fileObj["numLines"] = lineCount
	}
	if _, exists := fileObj["totalLines"]; !exists {
		fileObj["totalLines"] = lineCount
	}

	// Strip the content
	delete(fileObj, "content")
	return true
}

// stripImageToolUseResult strips base64 data from image tool results.
// Preserves dimensions, originalSize, and MIME type for potential future use.
func stripImageToolUseResult(toolUseResult map[string]interface{}) bool {
	fileObj, ok := toolUseResult["file"].(map[string]interface{})
	if !ok {
		return false
	}

	if _, hasBase64 := fileObj["base64"]; !hasBase64 {
		// No base64 to strip, but still an image result
		return true
	}

	delete(fileObj, "base64")
	return true
}

// stripToolResultBlocks replaces the content of tool_result blocks in message.content[].
// These blocks contain the same data as toolUseResult and are used only as a fallback.
func stripToolResultBlocks(msg map[string]interface{}) {
	msgObj, ok := msg["message"].(map[string]interface{})
	if !ok {
		return
	}
	contentArr, ok := msgObj["content"].([]interface{})
	if !ok {
		return
	}
	for _, block := range contentArr {
		blockMap, ok := block.(map[string]interface{})
		if !ok {
			continue
		}
		if blockMap["type"] == "tool_result" {
			blockMap["content"] = ""
		}
	}
}

// countLines returns the number of lines in a string.
// An empty string returns 0; a non-empty string returns at least 1.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}
